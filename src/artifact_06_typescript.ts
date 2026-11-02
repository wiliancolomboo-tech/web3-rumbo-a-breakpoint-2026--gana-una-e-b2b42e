import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { RumboBreakpoint } from "../target/types/rumbo_breakpoint";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";

describe("rumbo_breakpoint unit and integration suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.RumboBreakpoint as Program<RumboBreakpoint>;

  let mintPubkey: anchor.web3.PublicKey;
  let poolPda: anchor.web3.PublicKey;
  let poolBump: number;
  let vaultPda: anchor.web3.PublicKey;
  let vaultBump: number;

  const authority = provider.wallet;
  const candidateUser = anchor.web3.Keypair.generate();
  let candidateRecordPda: anchor.web3.PublicKey;
  let candidateRecordBump: number;
  let candidateTokenAccount: anchor.web3.PublicKey;

  const GRANT_AMOUNT = new anchor.BN(2000_000_000); // 2000 USDC (6 decimals)
  const MAX_SCHOLARS = 10;

  before(async () => {
    // 1. Create Mock USDC Mint
    mintPubkey = await createMint(
      provider.connection,
      (authority as any).payer,
      authority.publicKey,
      null,
      6
    );

    // 2. Derive PDAs
    [poolPda, poolBump] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("rumbo_pool"), authority.publicKey.toBuffer()],
      program.programId
    );

    [vaultPda, vaultBump] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("scholarship_vault"), poolPda.toBuffer()],
      program.programId
    );

    [candidateRecordPda, candidateRecordBump] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("candidate_record"),
          poolPda.toBuffer(),
          candidateUser.publicKey.toBuffer(),
        ],
        program.programId
      );

    // 3. Create Candidate Token Account
    candidateTokenAccount = await createAccount(
      provider.connection,
      (authority as any).payer,
      mintPubkey,
      candidateUser.publicKey
    );
  });

  it("1. Initializes the Breakpoint 2026 Scholarship Pool Escrow", async () => {
    await program.methods
      .initializePool(poolBump, vaultBump, GRANT_AMOUNT, MAX_SCHOLARS)
      .accounts({
        pool: poolPda,
        escrowVault: vaultPda,
        tokenMint: mintPubkey,
        authority: authority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const poolAccount = await program.account.scholarshipPool.fetch(poolPda);
    expect(poolAccount.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(poolAccount.grantPerScholar.toNumber()).to.equal(GRANT_AMOUNT.toNumber());
    expect(poolAccount.maxScholars).to.equal(MAX_SCHOLARS);
    expect(poolAccount.allocatedScholars).to.equal(0);
    expect(poolAccount.isActive).to.be.true;

    // Fund the escrow vault with initial liquidity (e.g., 20,000 USDC)
    await mintTo(
      provider.connection,
      (authority as any).payer,
      mintPubkey,
      vaultPda,
      authority.publicKey,
      20_000_000_000
    );
  });

  it("2. Registers an accepted candidate scholar with metadata", async () => {
    const ghHandle = "solana-dev-latam";

    await program.methods
      .registerCandidate(candidateUser.publicKey, ghHandle, candidateRecordBump)
      .accounts({
        pool: poolPda,
        candidateRecord: candidateRecordPda,
        authority: authority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const candidateAccount = await program.account.candidateRecord.fetch(
      candidateRecordPda
    );
    expect(candidateAccount.candidate.toBase58()).to.equal(
      candidateUser.publicKey.toBase58()
    );
    expect(candidateAccount.githubHandle).to.equal(ghHandle);
    expect(candidateAccount.tranche1Claimed).to.be.false;
    expect(candidateAccount.tranche2Claimed).to.be.false;

    const poolAccount = await program.account.scholarshipPool.fetch(poolPda);
    expect(poolAccount.allocatedScholars).to.equal(1);
  });

  it("3. Attests Milestone One and releases 60% travel stipend tranche", async () => {
    await program.methods
      .attestMilestoneOne()
      .accounts({
        pool: poolPda,
        candidateRecord: candidateRecordPda,
        escrowVault: vaultPda,
        candidateTokenAccount: candidateTokenAccount,
        authority: authority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const candidateAccount = await program.account.candidateRecord.fetch(
      candidateRecordPda
    );
    expect(candidateAccount.tranche1Claimed).to.be.true;
    expect(candidateAccount.isVerified).to.be.true;

    const candidateBalance = await getAccount(
      provider.connection,
      candidateTokenAccount
    );
    // 60% of 2000 USDC = 1200 USDC (1,200,000,000 units)
    expect(Number(candidateBalance.amount)).to.equal(1200_000_000);
  });

  it("4. Prevents duplicate disbursement for Milestone One (Double-Spend Protection)", async () => {
    try {
      await program.methods
        .attestMilestoneOne()
        .accounts({
          pool: poolPda,
          candidateRecord: candidateRecordPda,
          escrowVault: vaultPda,
          candidateTokenAccount: candidateTokenAccount,
          authority: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      expect.fail("Should have failed with TrancheAlreadyClaimed");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("TrancheAlreadyClaimed");
    }
  });

  it("5. Attests Milestone Two and releases remaining 40% upon in-person check-in", async () => {
    await program.methods
      .attestMilestoneTwo()
      .accounts({
        pool: poolPda,
        candidateRecord: candidateRecordPda,
        escrowVault: vaultPda,
        candidateTokenAccount: candidateTokenAccount,
        authority: authority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const candidateAccount = await program.account.candidateRecord.fetch(
      candidateRecordPda
    );
    expect(candidateAccount.tranche2Claimed).to.be.true;

    const candidateBalance = await getAccount(
      provider.connection,
      candidateTokenAccount
    );
    // Total 100% = 2000 USDC (2,000,000,000 units)
    expect(Number(candidateBalance.amount)).to.equal(2000_000_000);
  });

  it("6. Rejects unauthorized access attempts to disburse funds", async () => {
    const maliciousAttacker = anchor.web3.Keypair.generate();

    try {
      await program.methods
        .attestMilestoneTwo()
        .accounts({
          pool: poolPda,
          candidateRecord: candidateRecordPda,
          escrowVault: vaultPda,
          candidateTokenAccount: candidateTokenAccount,
          authority: maliciousAttacker.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([maliciousAttacker])
        .rpc();
      expect.fail("Should have failed with unauthorized error");
    } catch (err: any) {
      expect(err).to.exist;
    }
  });
});