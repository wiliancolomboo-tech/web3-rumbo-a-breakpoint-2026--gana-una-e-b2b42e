import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CaminoEscrow } from "../target/types/camino_escrow";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("camino_escrow - Rumbo a Breakpoint 2026 End-to-End Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.CaminoEscrow as Program<CaminoEscrow>;

  const admin = Keypair.generate();
  const applicant = Keypair.generate();
  const unauthorizedUser = Keypair.generate();

  let tokenMint: PublicKey;
  let adminTokenAccount: PublicKey;
  let applicantTokenAccount: PublicKey;

  const campaignId = new anchor.BN(2026);
  const stipendAmount = new anchor.BN(2_500_000_000); // 2,500 USDC (6 decimals)
  const maxGrantees = 5;

  let campaignPDA: PublicKey;
  let vaultPDA: PublicKey;
  let applicationPDA: PublicKey;

  before(async () => {
    // Airdrop SOL
    for (const kp of [admin, applicant, unauthorizedUser]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // Create Mock USDC Mint
    tokenMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    // Create Token Accounts
    adminTokenAccount = await createAccount(
      provider.connection,
      admin,
      tokenMint,
      admin.publicKey
    );

    applicantTokenAccount = await createAccount(
      provider.connection,
      applicant,
      tokenMint,
      applicant.publicKey
    );

    // Mint funds to admin (100,000 USDC)
    await mintTo(
      provider.connection,
      admin,
      tokenMint,
      adminTokenAccount,
      admin,
      100_000_000_000
    );

    // Derive PDAs
    [campaignPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign"), campaignId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [vaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), campaignId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [applicationPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("application"), campaignPDA.toBuffer(), applicant.publicKey.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes the Rumbo a Breakpoint campaign successfully", async () => {
    const title = "Rumbo a Breakpoint 2026";
    await program.methods
      .initializeCampaign(campaignId, title, stipendAmount, maxGrantees)
      .accounts({
        campaign: campaignPDA,
        tokenMint: tokenMint,
        vault: vaultPDA,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    const campAccount = await program.account.campaign.fetch(campaignPDA);
    expect(campAccount.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(campAccount.title).to.equal(title);
    expect(campAccount.stipendPerGrantee.toString()).to.equal(stipendAmount.toString());
    expect(campAccount.maxGrantees).to.equal(maxGrantees);
    expect(campAccount.approvedCount).to.equal(0);
  });

  it("2. Funds the campaign escrow vault with 25,000 USDC", async () => {
    const depositAmount = new anchor.BN(25_000_000_000);

    await program.methods
      .fundCampaign(depositAmount)
      .accounts({
        campaign: campaignPDA,
        vault: vaultPDA,
        funderTokenAccount: adminTokenAccount,
        funder: admin.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([admin])
      .rpc();

    const vaultInfo = await getAccount(provider.connection, vaultPDA);
    expect(Number(vaultInfo.amount)).to.equal(depositAmount.toNumber());
  });

  it("3. Builder submits grant application with IPFS proposal CID", async () => {
    const proposalHash = "QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco";

    await program.methods
      .submitApplication(proposalHash)
      .accounts({
        campaign: campaignPDA,
        application: applicationPDA,
        applicant: applicant.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([applicant])
      .rpc();

    const appState = await program.account.grantApplication.fetch(applicationPDA);
    expect(appState.applicant.toBase58()).to.equal(applicant.publicKey.toBase58());
    expect(appState.proposalHash).to.equal(proposalHash);
    expect(appState.status).to.deep.equal({ submitted: {} });
    expect(appState.disbursedAmount.toNumber()).to.equal(0);
  });

  it("4. Prevents unauthorized reviewer from approving the application", async () => {
    try {
      await program.methods
        .approveApplication()
        .accounts({
          campaign: campaignPDA,
          application: applicationPDA,
          admin: unauthorizedUser.publicKey,
        })
        .signers([unauthorizedUser])
        .rpc();
      expect.fail("Should have thrown unauthorized error");
    } catch (err: any) {
      expect(err.toString()).to.include("Unauthorized");
    }
  });

  it("5. Admin approves builder application", async () => {
    await program.methods
      .approveApplication()
      .accounts({
        campaign: campaignPDA,
        application: applicationPDA,
        admin: admin.publicKey,
      })
      .signers([admin])
      .rpc();

    const appState = await program.account.grantApplication.fetch(applicationPDA);
    expect(appState.status).to.deep.equal({ approved: {} });

    const campState = await program.account.campaign.fetch(campaignPDA);
    expect(campState.approvedCount).to.equal(1);
  });

  it("6. Builder claims Tranche 1 (60% = 1,500 USDC) for flights and ticket", async () => {
    const initialBal = await getAccount(provider.connection, applicantTokenAccount);

    await program.methods
      .claimTravelStipend()
      .accounts({
        campaign: campaignPDA,
        vault: vaultPDA,
        application: applicationPDA,
        applicantTokenAccount: applicantTokenAccount,
        applicant: applicant.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([applicant])
      .rpc();

    const afterBal = await getAccount(provider.connection, applicantTokenAccount);
    const expectedTranche1 = 1_500_000_000; // 60% of 2500 USDC
    expect(Number(afterBal.amount) - Number(initialBal.amount)).to.equal(expectedTranche1);

    const appState = await program.account.grantApplication.fetch(applicationPDA);
    expect(appState.status).to.deep.equal({ tranche1Claimed: {} });
    expect(appState.disbursedAmount.toNumber()).to.equal(expectedTranche1);
  });

  it("7. Prevents claiming Tranche 1 twice (Anti-Double-Spend)", async () => {
    try {
      await program.methods
        .claimTravelStipend()
        .accounts({
          campaign: campaignPDA,
          vault: vaultPDA,
          application: applicationPDA,
          applicantTokenAccount: applicantTokenAccount,
          applicant: applicant.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([applicant])
        .rpc();
      expect.fail("Double claim must fail");
    } catch (err: any) {
      expect(err.toString()).to.include("InvalidApplicationState");
    }
  });

  it("8. Physical check-in / Demo day: Admin finalizes and releases Tranche 2 (40% = 1,000 USDC)", async () => {
    const initialBal = await getAccount(provider.connection, applicantTokenAccount);

    await program.methods
      .verifyMilestoneAndFinalize()
      .accounts({
        campaign: campaignPDA,
        vault: vaultPDA,
        application: applicationPDA,
        applicantTokenAccount: applicantTokenAccount,
        admin: admin.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([admin])
      .rpc();

    const afterBal = await getAccount(provider.connection, applicantTokenAccount);
    const expectedTranche2 = 1_000_000_000; // Remaining 40%
    expect(Number(afterBal.amount) - Number(initialBal.amount)).to.equal(expectedTranche2);

    const appState = await program.account.grantApplication.fetch(applicationPDA);
    expect(appState.status).to.deep.equal({ fullyFinalized: {} });
    expect(appState.disbursedAmount.toNumber()).to.equal(stipendAmount.toNumber());
  });
});