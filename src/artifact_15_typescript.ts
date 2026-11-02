import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { RumboProtocol } from "../target/types/rumbo_protocol";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("rumbo-protocol comprehensive verification", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.RumboProtocol as Program<RumboProtocol>;

  let mintKeypair: Keypair;
  let tokenMint: PublicKey;
  let sponsor: Keypair;
  let scholar: Keypair;
  let maliciousUser: Keypair;

  let sponsorTokenAccount: PublicKey;
  let scholarTokenAccount: PublicKey;

  let campaignPda: PublicKey;
  let campaignBump: number;
  let vaultPda: PublicKey;
  let vaultBump: number;
  let granteePda: PublicKey;
  let granteeBump: number;

  const campaignTitle = "Breakpoint2026-Superteam";
  const totalAllocation = new anchor.BN(10_000 * 1_000_000); // 10,000 USDC
  const stipendPerScholar = new anchor.BN(1_500 * 1_000_000); // 1,500 USDC
  const durationSeconds = new anchor.BN(86400 * 30); // 30 days

  before(async () => {
    sponsor = Keypair.generate();
    scholar = Keypair.generate();
    maliciousUser = Keypair.generate();
    mintKeypair = Keypair.generate();

    // Airdrop SOL for gas
    for (const kp of [sponsor, scholar, maliciousUser]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        5 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    // Create Mock USDC Mint
    tokenMint = await createMint(
      provider.connection,
      sponsor,
      sponsor.publicKey,
      null,
      6
    );

    // Initialize Token Accounts
    sponsorTokenAccount = await createAccount(
      provider.connection,
      sponsor,
      tokenMint,
      sponsor.publicKey
    );

    scholarTokenAccount = await createAccount(
      provider.connection,
      scholar,
      tokenMint,
      scholar.publicKey
    );

    // Mint USDC into Sponsor Token Account
    await mintTo(
      provider.connection,
      sponsor,
      tokenMint,
      sponsorTokenAccount,
      sponsor.publicKey,
      20_000 * 1_000_000
    );

    // Derive PDA addresses
    [campaignPda, campaignBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("campaign"),
        sponsor.publicKey.toBuffer(),
        Buffer.from(campaignTitle),
      ],
      program.programId
    );

    [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), campaignPda.toBuffer()],
      program.programId
    );

    [granteePda, granteeBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("grantee"),
        campaignPda.toBuffer(),
        scholar.publicKey.toBuffer(),
      ],
      program.programId
    );
  });

  it("1. Initializes the Rumbo Campaign with Escrow Vault", async () => {
    await program.methods
      .initializeCampaign(
        campaignTitle,
        totalAllocation,
        stipendPerScholar,
        durationSeconds
      )
      .accounts({
        authority: sponsor.publicKey,
        tokenMint: tokenMint,
        campaign: campaignPda,
        vault: vaultPda,
        sponsorTokenAccount: sponsorTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([sponsor])
      .rpc();

    const campaignAccount = await program.account.campaign.fetch(campaignPda);
    expect(campaignAccount.title).to.equal(campaignTitle);
    expect(campaignAccount.totalAllocation.toString()).to.equal(totalAllocation.toString());
    expect(campaignAccount.disbursedAmount.toString()).to.equal("0");

    const vaultBalance = await getAccount(provider.connection, vaultPda);
    expect(vaultBalance.amount.toString()).to.equal(totalAllocation.toString());
  });

  it("2. Allows a Scholar to apply for Rumbo a Breakpoint Grant", async () => {
    const githubHandle = "solana_builder_latam";
    const commitHash = "c0ffee99b740523fb68d374d81234907";
    const totalMilestones = 2;

    await program.methods
      .applyGrant(githubHandle, commitHash, totalMilestones)
      .accounts({
        scholar: scholar.publicKey,
        campaign: campaignPda,
        grantee: granteePda,
        systemProgram: SystemProgram.programId,
      })
      .signers([scholar])
      .rpc();

    const granteeAccount = await program.account.grantee.fetch(granteePda);
    expect(granteeAccount.scholar.toBase58()).to.equal(scholar.publicKey.toBase58());
    expect(granteeAccount.handle).to.equal(githubHandle);
    expect(granteeAccount.milestoneCount).to.equal(2);
    expect(granteeAccount.milestonesApproved).to.equal(0);
    expect(granteeAccount.ticketIssued).to.be.false;
  });

  it("3. Prevents unauthorized review & milestone approval", async () => {
    try {
      await program.methods
        .approveMilestone()
        .accounts({
          reviewer: maliciousUser.publicKey,
          campaign: campaignPda,
          grantee: granteePda,
        })
        .signers([maliciousUser])
        .rpc();
      expect.fail("Unauthorized user should not approve milestone!");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedReviewer");
    }
  });

  it("4. Prevents premature fund claim before milestone completion", async () => {
    try {
      await program.methods
        .claimTravelStipend()
        .accounts({
          scholar: scholar.publicKey,
          campaign: campaignPda,
          grantee: granteePda,
          vault: vaultPda,
          scholarTokenAccount: scholarTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([scholar])
        .rpc();
      expect.fail("Should not claim funds prior to full verification!");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("GranteeNotVerified");
    }
  });

  it("5. Approves Milestone 1 (Partial verification)", async () => {
    await program.methods
      .approveMilestone()
      .accounts({
        reviewer: sponsor.publicKey,
        campaign: campaignPda,
        grantee: granteePda,
      })
      .signers([sponsor])
      .rpc();

    const granteeAccount = await program.account.grantee.fetch(granteePda);
    expect(granteeAccount.milestonesApproved).to.equal(1);
    expect(granteeAccount.ticketIssued).to.be.false;
  });

  it("6. Approves Milestone 2 (Full Verification & Ticket Granted)", async () => {
    await program.methods
      .approveMilestone()
      .accounts({
        reviewer: sponsor.publicKey,
        campaign: campaignPda,
        grantee: granteePda,
      })
      .signers([sponsor])
      .rpc();

    const granteeAccount = await program.account.grantee.fetch(granteePda);
    expect(granteeAccount.milestonesApproved).to.equal(2);
    expect(granteeAccount.ticketIssued).to.be.true; // Scholar granted Breakpoint 2026 Ticket!
  });

  it("7. Executes Claim of Travel Stipend Escrow", async () => {
    const preScholarBalance = await getAccount(provider.connection, scholarTokenAccount);

    await program.methods
      .claimTravelStipend()
      .accounts({
        scholar: scholar.publicKey,
        campaign: campaignPda,
        grantee: granteePda,
        vault: vaultPda,
        scholarTokenAccount: scholarTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([scholar])
      .rpc();

    const postScholarBalance = await getAccount(provider.connection, scholarTokenAccount);
    const granteeAccount = await program.account.grantee.fetch(granteePda);
    const campaignAccount = await program.account.campaign.fetch(campaignPda);

    expect(granteeAccount.fundsClaimed).to.be.true;
    expect(
      BigInt(postScholarBalance.amount) - BigInt(preScholarBalance.amount)
    ).to.equal(BigInt(stipendPerScholar.toString()));
    expect(campaignAccount.disbursedAmount.toString()).to.equal(stipendPerScholar.toString());
  });

  it("8. Rejects double claiming of stipend funds", async () => {
    try {
      await program.methods
        .claimTravelStipend()
        .accounts({
          scholar: scholar.publicKey,
          campaign: campaignPda,
          grantee: granteePda,
          vault: vaultPda,
          scholarTokenAccount: scholarTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([scholar])
        .rpc();
      expect.fail("Double claiming should fail!");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("AlreadyClaimed");
    }
  });
});