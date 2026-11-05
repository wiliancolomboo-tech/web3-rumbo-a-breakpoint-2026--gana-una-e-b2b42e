import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { RumboEscrow } from "../target/types/rumbo_escrow";
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL, Keypair } from "@solana/web3.js";
import { assert, expect } from "chai";

describe("rumbo_escrow unit & integration suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.RumboEscrow as Program<RumboEscrow>;

  const councilMember = Keypair.generate();
  const applicant = Keypair.generate();
  const unauthorizedActor = Keypair.generate();

  const STIPEND_AMOUNT = new anchor.BN(2 * LAMPORTS_PER_SOL);
  const INITIAL_VAULT_FUND = new anchor.BN(10 * LAMPORTS_PER_SOL);

  let poolPda: PublicKey;
  let vaultPda: PublicKey;
  let applicationPda: PublicKey;

  before(async () => {
    // Fund test wallets
    const airdropSignatures = await Promise.all([
      provider.connection.requestAirdrop(councilMember.publicKey, 5 * LAMPORTS_PER_SOL),
      provider.connection.requestAirdrop(applicant.publicKey, 5 * LAMPORTS_PER_SOL),
      provider.connection.requestAirdrop(unauthorizedActor.publicKey, 2 * LAMPORTS_PER_SOL),
    ]);

    for (const sig of airdropSignatures) {
      const latestBlockhash = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        signature: sig,
        ...latestBlockhash,
      });
    }

    [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("grant_pool"), provider.wallet.publicKey.toBuffer()],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), poolPda.toBuffer()],
      program.programId
    );

    [applicationPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("grantee"), poolPda.toBuffer(), applicant.publicKey.toBuffer()],
      program.programId
    );
  });

  it("1. Successfully initializes the GrantPool with liquidity", async () => {
    await program.methods
      .initializePool(STIPEND_AMOUNT, INITIAL_VAULT_FUND)
      .accounts({
        pool: poolPda,
        vault: vaultPda,
        authority: provider.wallet.publicKey,
        councilMultisig: councilMember.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const poolAccount = await program.account.grantPool.fetch(poolPda);
    assert.equal(poolAccount.authority.toBase58(), provider.wallet.publicKey.toBase58());
    assert.equal(poolAccount.councilMultisig.toBase58(), councilMember.publicKey.toBase58());
    assert.equal(poolAccount.stipendPerGrantee.toString(), STIPEND_AMOUNT.toString());

    const vaultBalance = await provider.connection.getBalance(vaultPda);
    assert.equal(vaultBalance, INITIAL_VAULT_FUND.toNumber());
  });

  it("2. Submits candidate application to Rumbo a Breakpoint", async () => {
    const demoUri = "ipfs://QmRumboBreakpoint2026BuilderPortfolioHash";

    await program.methods
      .submitApplication(demoUri)
      .accounts({
        pool: poolPda,
        application: applicationPda,
        applicant: applicant.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([applicant])
      .rpc();

    const appState = await program.account.granteeApplication.fetch(applicationPda);
    assert.equal(appState.applicant.toBase58(), applicant.publicKey.toBase58());
    assert.equal(appState.approvedMilestones, 0);
    assert.equal(appState.isApproved, false);
    assert.equal(appState.totalClaimed.toNumber(), 0);
  });

  it("3. Fails when unauthorized caller attempts to attest milestone", async () => {
    try {
      await program.methods
        .attestMilestone(1)
        .accounts({
          pool: poolPda,
          application: applicationPda,
          granteeUser: applicant.publicKey,
          councilMultisig: unauthorizedActor.publicKey,
        })
        .signers([unauthorizedActor])
        .rpc();
      assert.fail("Should have failed with unauthorized council error");
    } catch (err: any) {
      expect(err.toString()).to.include("UnauthorizedCouncilMember");
    }
  });

  it("4. Council attests Milestone 1 (Travel & Flight Confirmation)", async () => {
    await program.methods
      .attestMilestone(1)
      .accounts({
        pool: poolPda,
        application: applicationPda,
        granteeUser: applicant.publicKey,
        councilMultisig: councilMember.publicKey,
      })
      .signers([councilMember])
      .rpc();

    const appState = await program.account.granteeApplication.fetch(applicationPda);
    assert.equal(appState.approvedMilestones, 1);
    assert.equal(appState.isApproved, true);
    assert.equal(appState.isCompleted, false);
  });

  it("5. Grantee claims Tranche 1 (50% travel advance)", async () => {
    const initialApplicantBal = await provider.connection.getBalance(applicant.publicKey);

    await program.methods
      .claimTranche()
      .accounts({
        pool: poolPda,
        vault: vaultPda,
        application: applicationPda,
        applicant: applicant.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([applicant])
      .rpc();

    const updatedAppState = await program.account.granteeApplication.fetch(applicationPda);
    const expectedTrancheOne = 1 * LAMPORTS_PER_SOL; // 50% of 2 SOL
    assert.equal(updatedAppState.totalClaimed.toNumber(), expectedTrancheOne);

    const postApplicantBal = await provider.connection.getBalance(applicant.publicKey);
    assert.isAbove(postApplicantBal, initialApplicantBal);
  });

  it("6. Rejects double-claim of Tranche 1 before Milestone 2 is attested", async () => {
    try {
      await program.methods
        .claimTranche()
        .accounts({
          pool: poolPda,
          vault: vaultPda,
          application: applicationPda,
          applicant: applicant.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([applicant])
        .rpc();
      assert.fail("Should have rejected with NoClaimableFundsAvailable");
    } catch (err: any) {
      expect(err.toString()).to.include("NoClaimableFundsAvailable");
    }
  });

  it("7. Council attests Milestone 2 & Applicant claims final completion tranche", async () => {
    await program.methods
      .attestMilestone(2)
      .accounts({
        pool: poolPda,
        application: applicationPda,
        granteeUser: applicant.publicKey,
        councilMultisig: councilMember.publicKey,
      })
      .signers([councilMember])
      .rpc();

    let appState = await program.account.granteeApplication.fetch(applicationPda);
    assert.equal(appState.approvedMilestones, 2);
    assert.equal(appState.isCompleted, true);

    await program.methods
      .claimTranche()
      .accounts({
        pool: poolPda,
        vault: vaultPda,
        application: applicationPda,
        applicant: applicant.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([applicant])
      .rpc();

    appState = await program.account.granteeApplication.fetch(applicationPda);
    assert.equal(appState.totalClaimed.toNumber(), STIPEND_AMOUNT.toNumber());
  });
});