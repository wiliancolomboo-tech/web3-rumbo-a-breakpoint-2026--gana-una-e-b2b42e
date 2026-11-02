import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";
import * as crypto from "crypto";

describe("rumbo-protocol integration test suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // We compile and read IDL dynamically
  const idl = JSON.parse(
    fs.readFileSync("./target/idl/rumbo_protocol.json", "utf8")
  );
  const program = new anchor.Program(idl, provider);

  const poolId = "breakpoint-2026-test";
  const curator = (provider.wallet as any).payer as Keypair;
  const applicant = Keypair.generate();
  const grantAmount = new anchor.BN(2 * LAMPORTS_PER_SOL);

  let poolPda: PublicKey;
  let vaultPda: PublicKey;
  let applicationPda: PublicKey;

  before(async () => {
    // Airdrop funds to applicant
    const sig = await provider.connection.requestAirdrop(
      applicant.publicKey,
      5 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);

    [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), Buffer.from(poolId)],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), poolPda.toBuffer()],
      program.programId
    );

    [applicationPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("application"),
        poolPda.toBuffer(),
        applicant.publicKey.toBuffer()
      ],
      program.programId
    );
  });

  it("1. Initializes the Grant Pool with 60/40 milestone tranches", async () => {
    await program.methods
      .initializePool(poolId, 60, 40)
      .accounts({
        pool: poolPda,
        vault: vaultPda,
        authority: curator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const poolAccount = await program.account.grantPool.fetch(poolPda);
    expect(poolAccount.poolId).to.equal(poolId);
    expect(poolAccount.trancheOnePct).to.equal(60);
    expect(poolAccount.trancheTwoPct).to.equal(40);
    expect(poolAccount.totalFunds.toNumber()).to.equal(0);
  });

  it("2. Funds the Grant Pool with 10 SOL", async () => {
    const fundAmount = new anchor.BN(10 * LAMPORTS_PER_SOL);

    await program.methods
      .fundPool(fundAmount)
      .accounts({
        pool: poolPda,
        vault: vaultPda,
        funder: curator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const poolAccount = await program.account.grantPool.fetch(poolPda);
    expect(poolAccount.totalFunds.toNumber()).to.equal(fundAmount.toNumber());

    const vaultBalance = await provider.connection.getBalance(vaultPda);
    expect(vaultBalance).to.equal(fundAmount.toNumber());
  });

  it("3. Developer submits an application for Breakpoint 2026", async () => {
    const dummyDevnetProgram = Keypair.generate().publicKey;

    await program.methods
      .submitApplication(
        "solana-dev-latam",
        "DeFi & Infrastructure",
        grantAmount,
        dummyDevnetProgram
      )
      .accounts({
        pool: poolPda,
        application: applicationPda,
        applicant: applicant.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([applicant])
      .rpc();

    const appAccount = await program.account.grantApplication.fetch(applicationPda);
    expect(appAccount.githubHandle).to.equal("solana-dev-latam");
    expect(appAccount.requestedAmount.toNumber()).to.equal(grantAmount.toNumber());
    expect(JSON.stringify(appAccount.status)).to.include("pending");
  });

  it("4. Curator approves the application for 2 SOL", async () => {
    await program.methods
      .evaluateApplication({ approved: {} }, grantAmount)
      .accounts({
        pool: poolPda,
        application: applicationPda,
        authority: curator.publicKey,
      })
      .rpc();

    const appAccount = await program.account.grantApplication.fetch(applicationPda);
    expect(JSON.stringify(appAccount.status)).to.include("approved");
    expect(appAccount.approvedAmount.toNumber()).to.equal(grantAmount.toNumber());

    const poolAccount = await program.account.grantPool.fetch(poolPda);
    expect(poolAccount.allocatedFunds.toNumber()).to.equal(grantAmount.toNumber());
  });

  it("5. Developer claims Tranche 1 (60% for Flight & Ticket)", async () => {
    const ticketBytes = Array.from(crypto.createHash("sha256").update("TICKET-BKPT-2026-X").digest());
    const initialApplicantBal = await provider.connection.getBalance(applicant.publicKey);

    await program.methods
      .claimTrancheOne(ticketBytes)
      .accounts({
        pool: poolPda,
        vault: vaultPda,
        application: applicationPda,
        applicant: applicant.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([applicant])
      .rpc();

    const postApplicantBal = await provider.connection.getBalance(applicant.publicKey);
    const expectedPayout = (grantAmount.toNumber() * 60) / 100; // 1.2 SOL

    expect(postApplicantBal).to.be.greaterThan(initialApplicantBal);
    const appAccount = await program.account.grantApplication.fetch(applicationPda);
    expect(appAccount.trancheOneDisbursed).to.be.true;
    expect(JSON.stringify(appAccount.status)).to.include("trancheOneClaimed");
  });

  it("6. Developer claims Tranche 2 (40% Proof of Attendance)", async () => {
    const attendanceBytes = Array.from(crypto.createHash("sha256").update("ATTEND-BADGE-990-VERIFIED").digest());

    await program.methods
      .claimTrancheTwo(attendanceBytes)
      .accounts({
        pool: poolPda,
        vault: vaultPda,
        application: applicationPda,
        applicant: applicant.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([applicant])
      .rpc();

    const appAccount = await program.account.grantApplication.fetch(applicationPda);
    expect(appAccount.trancheTwoDisbursed).to.be.true;
    expect(JSON.stringify(appAccount.status)).to.include("completed");

    const poolAccount = await program.account.grantPool.fetch(poolPda);
    expect(poolAccount.disbursedFunds.toNumber()).to.equal(grantAmount.toNumber());
  });

  it("7. Fails when unauthorized user attempts to re-claim funds", async () => {
    const maliciousBytes = Array.from(crypto.randomBytes(32));
    try {
      await program.methods
        .claimTrancheTwo(maliciousBytes)
        .accounts({
          pool: poolPda,
          vault: vaultPda,
          application: applicationPda,
          applicant: applicant.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([applicant])
        .rpc();
      expect.fail("Should have failed to claim already completed grant");
    } catch (err: any) {
      expect(err.toString()).to.include("TrancheTwoUnsatisfied");
    }
  });
});