import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { RumboEscrow } from "../target/types/rumbo_escrow";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";
import * as crypto from "crypto";

describe("rumbo_escrow test suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.RumboEscrow as Program<RumboEscrow>;

  const authority = Keypair.generate();
  const sponsor = Keypair.generate();
  const builder = Keypair.generate();
  const juror1 = Keypair.generate();
  const attacker = Keypair.generate();

  const grantId = new anchor.BN(202601);
  const totalAmount = new anchor.BN(4 * LAMPORTS_PER_SOL);
  const m1 = new anchor.BN(2 * LAMPORTS_PER_SOL);
  const m2 = new anchor.BN(1 * LAMPORTS_PER_SOL);
  const m3 = new anchor.BN(1 * LAMPORTS_PER_SOL);

  let configPda: PublicKey;
  let grantPda: PublicKey;
  let vaultPda: PublicKey;

  before(async () => {
    // Airdrop SOL to test actors
    for (const actor of [authority, sponsor, builder, juror1, attacker]) {
      const sig = await provider.connection.requestAirdrop(actor.publicKey, 10 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig, "confirmed");
    }

    [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);

    [grantPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("grant"), builder.publicKey.toBuffer(), grantId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), grantPda.toBuffer()], program.programId);
  });

  it("1. Initializes global protocol configuration with 1-juror quorum threshold", async () => {
    const tx = await program.methods
      .initialize(1, 250) // 1 juror quorum, 2.5% fee limit
      .accounts({
        config: configPda,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    const configAccount = await program.account.config.fetch(configPda);
    expect(configAccount.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(configAccount.juryQuorumThreshold).to.equal(1);
    expect(configAccount.programFeeBasisPoints).to.equal(250);
  });

  it("2. Registers a new developer travel grant with 3 discrete milestones", async () => {
    const now = Math.floor(Date.now() / 1000);
    const expiry = new anchor.BN(now + 86400 * 30); // 30 days validity

    await program.methods
      .createGrant(grantId, totalAmount, [m1, m2, m3], expiry)
      .accounts({
        config: configPda,
        grantEscrow: grantPda,
        vault: vaultPda,
        builder: builder.publicKey,
        sponsor: sponsor.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([sponsor])
      .rpc();

    const grantAccount = await program.account.grantEscrow.fetch(grantPda);
    expect(grantAccount.builder.toBase58()).to.equal(builder.publicKey.toBase58());
    expect(grantAccount.sponsor.toBase58()).to.equal(sponsor.publicKey.toBase58());
    expect(grantAccount.totalAmount.toString()).to.equal(totalAmount.toString());
  });

  it("3. Funds the grant PDA vault with 4 SOL from sponsor", async () => {
    await program.methods
      .fundGrant(grantId)
      .accounts({
        grantEscrow: grantPda,
        vault: vaultPda,
        sponsor: sponsor.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([sponsor])
      .rpc();

    const vaultBalance = await provider.connection.getBalance(vaultPda);
    expect(vaultBalance).to.equal(4 * LAMPORTS_PER_SOL);
  });

  it("4. Builder submits proof hash for Milestone 0 (Flight & Ticket Receipt)", async () => {
    const dummyProof = crypto.createHash("sha256").update("LATAM_AIRLINES_BOOKING_REF_BKPT2026").digest();
    const proofArray = Array.from(dummyProof);

    await program.methods
      .submitMilestoneProof(grantId, 0, proofArray)
      .accounts({
        grantEscrow: grantPda,
        builder: builder.publicKey,
      })
      .signers([builder])
      .rpc();

    const grantAccount = await program.account.grantEscrow.fetch(grantPda);
    expect(grantAccount.milestoneStatus[0]).to.deep.equal({ submitted: {} });
  });

  it("5. Juror casts affirmative vote meeting the quorum requirement", async () => {
    const [voteRecordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vote"), grantPda.toBuffer(), Buffer.from([0]), juror1.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .castJuryVote(grantId, 0, true)
      .accounts({
        grantEscrow: grantPda,
        voteRecord: voteRecordPda,
        juror: juror1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([juror1])
      .rpc();

    const grantAccount = await program.account.grantEscrow.fetch(grantPda);
    expect(grantAccount.juryApprovals[0]).to.equal(1);
  });

  it("6. Disburses Milestone 0 (2 SOL) directly to builder's wallet", async () => {
    const builderBalanceBefore = await provider.connection.getBalance(builder.publicKey);

    await program.methods
      .disburseMilestone(grantId, 0)
      .accounts({
        config: configPda,
        grantEscrow: grantPda,
        vault: vaultPda,
        builder: builder.publicKey,
        caller: juror1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([juror1])
      .rpc();

    const builderBalanceAfter = await provider.connection.getBalance(builder.publicKey);
    expect(builderBalanceAfter - builderBalanceBefore).to.equal(2 * LAMPORTS_PER_SOL);

    const vaultBalanceRemaining = await provider.connection.getBalance(vaultPda);
    expect(vaultBalanceRemaining).to.equal(2 * LAMPORTS_PER_SOL);
  });

  it("7. Fails when an attacker attempts to disburse funds to an unauthorized address", async () => {
    try {
      await program.methods
        .disburseMilestone(grantId, 1)
        .accounts({
          config: configPda,
          grantEscrow: grantPda,
          vault: vaultPda,
          builder: attacker.publicKey, // Fraudulent address
          caller: attacker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([attacker])
        .rpc();
      expect.fail("Should have thrown constraint error");
    } catch (err: any) {
      expect(err.toString()).to.include("Error");
    }
  });
});