import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { RumboPassage } from "../target/types/rumbo_passage";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { expect } from "chai";

describe("rumbo-passage end-to-end test suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.RumboPassage as Program<RumboPassage>;

  const sponsor = Keypair.generate();
  const grantee = Keypair.generate();
  const maliciousActor = Keypair.generate();

  let vaultMint: PublicKey;
  let sponsorTokenAccount: PublicKey;
  let granteeTokenAccount: PublicKey;
  let campaignPda: PublicKey;
  let grantPda: PublicKey;
  let grantVaultPda: PublicKey;

  const campaignId = "breakpoint-2026-latam";
  const totalStipend = new anchor.BN(2_500_000_000); // 2,500 USDC (6 decimals)
  const milestoneSplits = [40, 40, 20]; // 40% prep, 40% arrival, 20% post-conference

  before(async () => {
    // Airdrop SOL to test actors
    for (const actor of [sponsor, grantee, maliciousActor]) {
      const sig = await provider.connection.requestAirdrop(actor.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // Create Mock USDC Token Mint
    vaultMint = await createMint(
      provider.connection,
      sponsor,
      sponsor.publicKey,
      null,
      6
    );

    // Setup Token Accounts
    const sponsorAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      sponsor,
      vaultMint,
      sponsor.publicKey
    );
    sponsorTokenAccount = sponsorAta.address;

    const granteeAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      grantee,
      vaultMint,
      grantee.publicKey
    );
    granteeTokenAccount = granteeAta.address;

    // Mint 50,000 mock USDC to sponsor
    await mintTo(
      provider.connection,
      sponsor,
      vaultMint,
      sponsorTokenAccount,
      sponsor.publicKey,
      50_000_000_000
    );

    // Derive Campaign PDA
    [campaignPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign"), sponsor.publicKey.toBuffer(), Buffer.from(campaignId)],
      program.programId
    );

    // Derive Grant PDA
    [grantPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("grant"), campaignPda.toBuffer(), grantee.publicKey.toBuffer()],
      program.programId
    );

    // Derive Grant Vault PDA
    [grantVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("grant-vault"), grantPda.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes the Breakpoint 2026 Campaign PDA with future clawback", async () => {
    const futureDeadline = new anchor.BN(Math.floor(Date.now() / 1000) + 86400 * 90); // 90 days out

    await program.methods
      .initializeCampaign(campaignId, futureDeadline)
      .accounts({
        campaign: campaignPda,
        vaultMint: vaultMint,
        authority: sponsor.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([sponsor])
      .rpc();

    const campaign = await program.account.campaignConfig.fetch(campaignPda);
    expect(campaign.authority.toBase58()).to.equal(sponsor.publicKey.toBase58());
    expect(campaign.campaignId).to.equal(campaignId);
    expect(campaign.totalAllocated.toNumber()).to.equal(0);
    expect(campaign.granteeCount).to.equal(0);
  });

  it("2. Allocates a 2,500 USDC Grant and deposits into Grant Vault PDA", async () => {
    await program.methods
      .createGrant(totalStipend, milestoneSplits)
      .accounts({
        campaign: campaignPda,
        vaultMint: vaultMint,
        grantee: grantee.publicKey,
        grant: grantPda,
        grantVault: grantVaultPda,
        sponsorTokenAccount: sponsorTokenAccount,
        authority: sponsor.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([sponsor])
      .rpc();

    const grant = await program.account.grantEscrow.fetch(grantPda);
    expect(grant.grantee.toBase58()).to.equal(grantee.publicKey.toBase58());
    expect(grant.totalAmount.toNumber()).to.equal(2_500_000_000);
    expect(grant.amountReleased.toNumber()).to.equal(0);
    expect(grant.currentMilestone).to.equal(0);

    const vaultBalance = await provider.connection.getTokenAccountBalance(grantVaultPda);
    expect(vaultBalance.value.uiAmount).to.equal(2500);
  });

  it("3. Prevents unauthorized submission of milestones", async () => {
    const [milestonePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("milestone"), grantPda.toBuffer(), Buffer.from([0])],
      program.programId
    );

    try {
      await program.methods
        .submitMilestone(0, "ipfs://QmFlightTicketsBookingRef123")
        .accounts({
          grant: grantPda,
          milestoneRecord: milestonePda,
          grantee: maliciousActor.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([maliciousActor])
        .rpc();
      expect.fail("Should have thrown Unauthorized error");
    } catch (err: any) {
      expect(err.toString()).to.include("Unauthorized");
    }
  });

  it("4. Grantee submits Milestone #0 (Flight & Lodging Proof)", async () => {
    const [milestonePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("milestone"), grantPda.toBuffer(), Buffer.from([0])],
      program.programId
    );

    await program.methods
      .submitMilestone(0, "ipfs://QmFlightBookingLatamToBreakpoint2026")
      .accounts({
        grant: grantPda,
        milestoneRecord: milestonePda,
        grantee: grantee.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([grantee])
      .rpc();

    const milestone = await program.account.milestoneRecord.fetch(milestonePda);
    expect(milestone.proofUri).to.equal("ipfs://QmFlightBookingLatamToBreakpoint2026");
    expect(milestone.milestoneIndex).to.equal(0);
  });

  it("5. Sponsor approves Milestone #0 and disburses 40% tranche (1,000 USDC)", async () => {
    const [milestonePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("milestone"), grantPda.toBuffer(), Buffer.from([0])],
      program.programId
    );

    const initialGranteeBalance = await provider.connection.getTokenAccountBalance(granteeTokenAccount);

    await program.methods
      .approveMilestoneAndDisburse(0)
      .accounts({
        campaign: campaignPda,
        vaultMint: vaultMint,
        grant: grantPda,
        milestoneRecord: milestonePda,
        grantVault: grantVaultPda,
        granteeTokenAccount: granteeTokenAccount,
        authority: sponsor.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([sponsor])
      .rpc();

    const updatedGranteeBalance = await provider.connection.getTokenAccountBalance(granteeTokenAccount);
    const diff = (updatedGranteeBalance.value.uiAmount || 0) - (initialGranteeBalance.value.uiAmount || 0);
    expect(diff).to.equal(1000); // 40% of 2,500 USDC

    const grant = await program.account.grantEscrow.fetch(grantPda);
    expect(grant.currentMilestone).to.equal(1);
    expect(grant.amountReleased.toNumber()).to.equal(1_000_000_000);
  });

  it("6. Rejects premature clawback before deadline epoch", async () => {
    try {
      await program.methods
        .clawbackUnclaimedFunds()
        .accounts({
          campaign: campaignPda,
          vaultMint: vaultMint,
          grant: grantPda,
          grantVault: grantVaultPda,
          sponsorTokenAccount: sponsorTokenAccount,
          authority: sponsor.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([sponsor])
        .rpc();
      expect.fail("Should have rejected clawback before deadline");
    } catch (err: any) {
      expect(err.toString()).to.include("ClawbackDeadlineNotMet");
    }
  });
});