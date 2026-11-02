import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { RumboProtocol } from "../target/types/rumbo_protocol";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";
import * as crypto from "crypto";

describe("rumbo_protocol test suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.RumboProtocol as Program<RumboProtocol>;

  const campaignId = "breakpoint-2026-latam";
  const ticketQuota = 10;
  const grantPerBuilder = new anchor.BN(2 * LAMPORTS_PER_SOL); // 2 SOL stipend
  const travelDeadline = new anchor.BN(Math.floor(Date.now() / 1000) + 86400 * 30); // 30 days ahead

  const sponsor = (provider.wallet as anchor.Wallet).payer;
  const builder = Keypair.generate();
  const unauthorizedUser = Keypair.generate();

  let campaignPda: PublicKey;
  let vaultPda: PublicKey;
  let applicantPda: PublicKey;
  let voucherPda: PublicKey;

  before(async () => {
    // Airdrop funds to builder and unauthorized test accounts
    const airdropSig1 = await provider.connection.requestAirdrop(builder.publicKey, 5 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(airdropSig1);

    const airdropSig2 = await provider.connection.requestAirdrop(unauthorizedUser.publicKey, 2 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(airdropSig2);

    // Derive deterministic PDAs
    [campaignPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign"), Buffer.from(campaignId)],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), Buffer.from(campaignId)],
      program.programId
    );

    [applicantPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("applicant"), campaignPda.toBuffer(), builder.publicKey.toBuffer()],
      program.programId
    );

    [voucherPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("voucher"), campaignPda.toBuffer(), builder.publicKey.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes the Rumbo Breakpoint Campaign & Seeds Vault Escrow", async () => {
    await program.methods
      .initializeCampaign(campaignId, ticketQuota, grantPerBuilder, travelDeadline)
      .accounts({
        campaign: campaignPda,
        vault: vaultPda,
        authority: sponsor.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([sponsor])
      .rpc();

    // Sponsor funds the Escrow Vault directly with 10 SOL
    const fundTx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: sponsor.publicKey,
        toPubkey: vaultPda,
        lamports: 10 * LAMPORTS_PER_SOL,
      })
    );
    await provider.sendAndConfirm(fundTx, [sponsor]);

    const campaignAccount = await program.account.campaign.fetch(campaignPda);
    expect(campaignAccount.campaignId).to.equal(campaignId);
    expect(campaignAccount.ticketQuota).to.equal(ticketQuota);
    expect(campaignAccount.ticketsIssued).to.equal(0);
    expect(campaignAccount.grantPerBuilder.toString()).to.equal(grantPerBuilder.toString());

    const vaultBalance = await provider.connection.getBalance(vaultPda);
    expect(vaultBalance).to.be.at.least(10 * LAMPORTS_PER_SOL);
  });

  it("2. Registers an eligible LATAM Builder for travel support", async () => {
    const rawMetadata = JSON.stringify({ bio: "Solana Rust Developer", github: "builder-latam" });
    const metadataHash = Array.from(crypto.createHash("sha256").update(rawMetadata).digest());

    await program.methods
      .registerApplicant(metadataHash, "Satoshi Hernandez", "Bogota, Colombia")
      .accounts({
        applicant: applicantPda,
        campaign: campaignPda,
        builder: builder.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([builder])
      .rpc();

    const applicantAccount = await program.account.applicant.fetch(applicantPda);
    expect(applicantAccount.builder.toBase58()).to.equal(builder.publicKey.toBase58());
    expect(applicantAccount.applicantName).to.equal("Satoshi Hernandez");
    expect(applicantAccount.originCity).to.equal("Bogota, Colombia");
    expect(applicantAccount.travelGrantClaimed.toNumber()).to.equal(0);
    expect(applicantAccount.ticketIssued).to.be.false;
  });

  it("3. Builder submits Visa & Flight Confirmation Proof", async () => {
    const flightReceiptHash = Array.from(
      crypto.createHash("sha256").update("FLIGHT-AVIANCA-BOG-TO-BREAKPOINT-2026").digest()
    );

    // Stage 3 = VisaAndFlightBooked
    await program.methods
      .submitMilestone(flightReceiptHash, { visaAndFlightBooked: {} })
      .accounts({
        applicant: applicantPda,
        campaign: campaignPda,
        builder: builder.publicKey,
      })
      .signers([builder])
      .rpc();

    const applicantAccount = await program.account.applicant.fetch(applicantPda);
    expect(applicantAccount.milestoneStage).to.deep.equal({ visaAndFlightBooked: {} });
  });

  it("4. Prevents unauthorized signers from acting as committee judges", async () => {
    try {
      await program.methods
        .attestAndApprove({ visaAndFlightBooked: {} }, 95)
        .accounts({
          applicant: applicantPda,
          campaign: campaignPda,
          judge: unauthorizedUser.publicKey,
        })
        .signers([unauthorizedUser])
        .rpc();
      expect.fail("Should have thrown unauthorized error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedJudge");
    }
  });

  it("5. Authorized Judge attests and approves Milestone", async () => {
    await program.methods
      .attestAndApprove({ visaAndFlightBooked: {} }, 92)
      .accounts({
        applicant: applicantPda,
        campaign: campaignPda,
        judge: sponsor.publicKey,
      })
      .signers([sponsor])
      .rpc();

    const applicantAccount = await program.account.applicant.fetch(applicantPda);
    expect(applicantAccount.verifiedStage).to.deep.equal({ visaAndFlightBooked: {} });
  });

  it("6. Builder claims Phase 1 (50%) Travel Escrow Lamports", async () => {
    const builderBalanceBefore = await provider.connection.getBalance(builder.publicKey);

    await program.methods
      .claimTravelGrant()
      .accounts({
        campaign: campaignPda,
        applicant: applicantPda,
        vault: vaultPda,
        builder: builder.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([builder])
      .rpc();

    const builderBalanceAfter = await provider.connection.getBalance(builder.publicKey);
    const applicantAccount = await program.account.applicant.fetch(applicantPda);

    // 50% of 2 SOL = 1 SOL
    expect(applicantAccount.travelGrantClaimed.toNumber()).to.equal(1 * LAMPORTS_PER_SOL);
    expect(builderBalanceAfter).to.be.greaterThan(builderBalanceBefore);
  });

  it("7. Issues Soulbound Breakpoint 2026 Ticket Voucher PDA", async () => {
    await program.methods
      .issueTicketVoucher()
      .accounts({
        campaign: campaignPda,
        applicant: applicantPda,
        voucher: voucherPda,
        authority: sponsor.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([sponsor])
      .rpc();

    const voucherAccount = await program.account.ticketVoucher.fetch(voucherPda);
    expect(voucherAccount.recipient.toBase58()).to.equal(builder.publicKey.toBase58());
    expect(voucherAccount.ticketNumber).to.equal(1);
    expect(voucherAccount.isClaimed).to.be.true;

    const campaignAccount = await program.account.campaign.fetch(campaignPda);
    expect(campaignAccount.ticketsIssued).to.equal(1);
  });

  it("8. Rejects duplicate ticket voucher issuance", async () => {
    try {
      await program.methods
        .issueTicketVoucher()
        .accounts({
          campaign: campaignPda,
          applicant: applicantPda,
          voucher: voucherPda,
          authority: sponsor.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([sponsor])
        .rpc();
      expect.fail("Should have failed to issue duplicate ticket");
    } catch (err: any) {
      // Re-initialization of the same voucher PDA or TicketAlreadyIssued error
      expect(err).to.exist;
    }
  });
});