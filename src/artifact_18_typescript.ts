// tests/breakpoint_pass.ts
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BreakpointPass } from "../target/types/breakpoint_pass";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";

describe("BreakpointPass - Full End-to-End Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.BreakpointPass as Program<BreakpointPass>;

  const admin = Keypair.generate();
  const verifier = Keypair.generate();
  const builderAlice = Keypair.generate();
  const builderBob = Keypair.generate();

  const campaignName = "Rumbo a Breakpoint 2026";
  const grantAmount = new anchor.BN(1.5 * LAMPORTS_PER_SOL);
  const totalTickets = 10;
  const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 86400); // +24 hours

  let campaignPDA: PublicKey;
  let vaultPDA: PublicKey;
  let aliceGrantPDA: PublicKey;
  let bobGrantPDA: PublicKey;

  before(async () => {
    // Airdrop SOL to test actors
    for (const kp of [admin, verifier, builderAlice, builderBob]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 10 * LAMPORTS_PER_SOL);
      const latestBlockHash = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        blockhash: latestBlockHash.blockhash,
        lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
        signature: sig,
      });
    }

    [campaignPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign"), admin.publicKey.toBuffer(), Buffer.from(campaignName)],
      program.programId
    );

    [vaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), campaignPDA.toBuffer()],
      program.programId
    );

    [aliceGrantPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("grant"), campaignPDA.toBuffer(), builderAlice.publicKey.toBuffer()],
      program.programId
    );

    [bobGrantPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("grant"), campaignPDA.toBuffer(), builderBob.publicKey.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes Campaign with valid configuration", async () => {
    await program.methods
      .initializeCampaign(campaignName, grantAmount, totalTickets, deadline)
      .accounts({
        admin: admin.publicKey,
        campaign: campaignPDA,
        vault: vaultPDA,
        verifierAuthority: verifier.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const campaignAccount = await program.account.campaign.fetch(campaignPDA);
    expect(campaignAccount.name).to.equal(campaignName);
    expect(campaignAccount.totalTicketsAvailable).to.equal(10);
    expect(campaignAccount.ticketsAwarded).to.equal(0);
    expect(campaignAccount.grantAmountPerBuilder.toString()).to.equal(grantAmount.toString());
  });

  it("2. Funds Escrow Vault with SOL", async () => {
    const depositAmount = new anchor.BN(5 * LAMPORTS_PER_SOL);
    await program.methods
      .depositFunds(depositAmount)
      .accounts({
        funder: admin.publicKey,
        campaign: campaignPDA,
        vault: vaultPDA,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const campaignAccount = await program.account.campaign.fetch(campaignPDA);
    expect(campaignAccount.availableFunds.toString()).to.equal(depositAmount.toString());

    const vaultBalance = await provider.connection.getBalance(vaultPDA);
    expect(vaultBalance).to.equal(depositAmount.toNumber());
  });

  it("3. Builder Alice submits grant application", async () => {
    await program.methods
      .applyGrant("solana_super_dev", "https://github.com/solana_super_dev/breakout-dex")
      .accounts({
        builder: builderAlice.publicKey,
        campaign: campaignPDA,
        grantApplication: aliceGrantPDA,
        systemProgram: SystemProgram.programId,
      })
      .signers([builderAlice])
      .rpc();

    const application = await program.account.grantApplication.fetch(aliceGrantPDA);
    expect(application.githubHandle).to.equal("solana_super_dev");
    expect(application.status).to.deep.equal({ applied: {} });
  });

  it("4. Prevents unauthorized actor from attesting and scoring", async () => {
    try {
      await program.methods
        .attestAndScore(85)
        .accounts({
          verifier: builderBob.publicKey, // Incorrect verifier!
          campaign: campaignPDA,
          grantApplication: aliceGrantPDA,
        })
        .signers([builderBob])
        .rpc();
      expect.fail("Should have thrown UnauthorizedVerifier error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedVerifier");
    }
  });

  it("5. Verifier successfully validates and scores Alice with 90/100", async () => {
    await program.methods
      .attestAndScore(90)
      .accounts({
        verifier: verifier.publicKey,
        campaign: campaignPDA,
        grantApplication: aliceGrantPDA,
      })
      .signers([verifier])
      .rpc();

    const application = await program.account.grantApplication.fetch(aliceGrantPDA);
    expect(application.status).to.deep.equal({ verified: {} });
    expect(application.builderScore).to.equal(90);
    expect(application.awardedAmount.toString()).to.equal(grantAmount.toString());
  });

  it("6. Alice claims grant funds and ticket successfully", async () => {
    const preAliceBalance = await provider.connection.getBalance(builderAlice.publicKey);

    await program.methods
      .claimGrantAndTicket()
      .accounts({
        builder: builderAlice.publicKey,
        campaign: campaignPDA,
        vault: vaultPDA,
        grantApplication: aliceGrantPDA,
        systemProgram: SystemProgram.programId,
      })
      .signers([builderAlice])
      .rpc();

    const postAliceBalance = await provider.connection.getBalance(builderAlice.publicKey);
    expect(postAliceBalance).to.be.gt(preAliceBalance);

    const updatedCampaign = await program.account.campaign.fetch(campaignPDA);
    expect(updatedCampaign.ticketsAwarded).to.equal(1);

    const updatedApp = await program.account.grantApplication.fetch(aliceGrantPDA);
    expect(updatedApp.status).to.deep.equal({ claimed: {} });
  });

  it("7. Builder Bob applies and gets rejected if score < 70", async () => {
    await program.methods
      .applyGrant("script_kiddie", "https://github.com/script_kiddie/empty-repo")
      .accounts({
        builder: builderBob.publicKey,
        campaign: campaignPDA,
        grantApplication: bobGrantPDA,
        systemProgram: SystemProgram.programId,
      })
      .signers([builderBob])
      .rpc();

    await program.methods
      .attestAndScore(45)
      .accounts({
        verifier: verifier.publicKey,
        campaign: campaignPDA,
        grantApplication: bobGrantPDA,
      })
      .signers([verifier])
      .rpc();

    const bobApp = await program.account.grantApplication.fetch(bobGrantPDA);
    expect(bobApp.status).to.deep.equal({ rejected: {} });

    // Attempting to claim must fail
    try {
      await program.methods
        .claimGrantAndTicket()
        .accounts({
          builder: builderBob.publicKey,
          campaign: campaignPDA,
          vault: vaultPDA,
          grantApplication: bobGrantPDA,
          systemProgram: SystemProgram.programId,
        })
        .signers([builderBob])
        .rpc();
      expect.fail("Should have failed with GrantNotVerified");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("GrantNotVerified");
    }
  });
});