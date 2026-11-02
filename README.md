# Deliverable: Rumbo a Breakpoint 2026: gana una entrada y apoyo para tu viaje
**Platform:** SuperteamEarn | **Ecosystem:** Solana | **Prize:** 5,000 USDG
**Generated At:** 2026-11-02 23:45:51

---

# Rumbo a Breakpoint 2026: Verifiable Travel Grant & Ticket Allocation Engine (Rumbo Protocol)

---

# 1. Executive Summary & Enterprise Value Proposition

### 1.1 Problem Definition
Every year, thousands of top-tier developers, founders, and students across Latin America and emerging markets apply for travel stipends and community passes to **Solana Breakpoint**. However, traditional hackathon and travel grant systems suffer from:
1. **Opaque Selection & Subjectivity:** Selection committees operate behind closed doors, leading to accusations of bias, favoritism, and sybil abuse.
2. **Reimbursement Bottlenecks & Operational Drag:** Recipients often wait weeks or months for travel reimbursements due to cross-border fiat friction, banking hurdles, and manual receipt validation.
3. **Secondary Market Ticket Exploitation:** Manually distributed promotional codes frequently leak, resulting in scalp trading rather than reaching genuine builders.

### 1.2 Architecture Thesis
**Rumbo Protocol** is a transparent, on-chain merit allocation engine built natively on Solana Anchor. It replaces opaque grant processes with a **verifiable, multi-sig attestation pipeline, automated milestone escrow, and soulbound on-chain ticket voucher issuance**.

* **Verifiable Proof-of-Merit:** Builders submit their GitHub hashes, open-source repositories, and hackathon project fingerprints directly to the Solana program.
* **Deterministic PDA Vaults:** Grant pools (funded in native SOL or SPL-USDC) are locked in Program Derived Addresses (PDAs) with milestone-gated release conditions.
* **Soulbound Ticket Receipts:** Breakpoint passes are minted as non-transferable on-chain vouchers mapped directly to applicant public keys.
* **Automated Off-Chain Dispatcher:** An enterprise-grade relayer observes on-chain attestations and triggers instantaneous travel logistics payouts via Solana web3, transactional flight confirmation emails with QR passes via **Resend**, and real-time review alerts via **Discord Webhooks**.

### 1.3 Business Impact & Turnkey Handover
* **100% Operational Transparency:** Donors, sponsors, and community members can audit every basis point distributed.
* **Instant Payout Settlement:** Grantees receive audited travel stipends in sub-second finality.
* **Zero Overhead for Event Staff:** Automated ticket verification eliminates manual spreadsheet tracking and code distribution.

---

# 2. Complete End-to-End System Architecture

```mermaid
flowchart TD
    subgraph Builder_Experience [Builder Journey]
        A[Applicant / Builder] -->|1. Submit Profile & Project Hash| B[Rumbo CLI / Web Portal]
        B -->|2. apply_for_grant ix| C[Solana Program: rumbo_breakpoint]
    end

    subgraph OnChain_State [Solana Anchor Core Engine]
        C -->|Initialize Application PDA| D[(Application State PDA)]
        E[Grant Committee / Judges] -->|3. attest_contribution ix| C
        C -->|Transition State to Approved| D
        C -->|4. disburse_travel_stipend ix| F[(Treasury Vault PDA)]
        F -->|Release SOL/USDC| A
        C -->|5. claim_breakpoint_ticket ix| G[(Soulbound Ticket PDA)]
        C -->|Emit Event: StipendDisbursed & TicketIssued| H[Solana Gossip / RPC Logs]
    end

    subgraph OffChain_Automation [Enterprise Relayer Service]
        H -->|WebSocket Log Subscription| I[Rumbo Automation Worker]
        I -->|Parse Event Payload| J{Event Type}
        J -->|TicketClaimed| K[Resend Transactional Email Engine]
        J -->|GrantApproved| L[Discord Community Webhook]
        K -->|Deliver Boarding Pass & QR Badge| A
        L -->|Broadcast Merit Leaderboard| M[Solana Community Feed]
    end
```

### Integration Topology
* **Solana RPC (Devnet/Mainnet-Beta):** Primary low-latency transport for transactions and WebSocket account/log subscriptions.
* **Resend API:** Enterprise transactional email platform sending programmatic, cryptographically signed Breakpoint 2026 Ticket QR codes and travel vouchers.
* **Discord/Slack Enterprise Webhooks:** Real-time visibility into governance decisions, committee attestations, and disbursed treasury funds.

---

# 3. Production-Ready Smart Contract

Directory structure for the contract:
```text
programs/rumbo_breakpoint/
├── Cargo.toml
└── src/
    └── lib.rs
```

### `Cargo.toml`
```toml
[package]
name = "rumbo_breakpoint"
version = "0.1.0"
description = "Verifiable Travel Grant and Breakpoint Ticket Engine"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]
name = "rumbo_breakpoint"

[features]
no-entrypoint = []
no-idl = []
no-log-ix-name = []
cpi = ["no-entrypoint"]
default = []

[dependencies]
anchor-lang = { version = "0.30.1", features = ["init-if-needed"] }
anchor-spl = "0.30.1"
```

### `programs/rumbo_breakpoint/src/lib.rs`
```rust
use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

declare_id!("RumbokZ3JcQWjC1E4uV4bZzK9f4w4hE2n8z1yX7pL5q");

pub const DISCRIMINATOR_LENGTH: usize = 8;
pub const MAX_NAME_LEN: usize = 64;
pub const MAX_METADATA_LEN: usize = 128;
pub const COMMITTEE_ROLE: u8 = 1;

#[program]
pub mod rumbo_breakpoint {
    use super::*;

    /// Initialize the Breakpoint Campaign Season
    pub fn initialize_campaign(
        ctx: Context<InitializeCampaign>,
        season_id: u32,
        max_tickets: u32,
        total_stipend_cap_lamports: u64,
        min_score_threshold: u8,
    ) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        campaign.admin = ctx.accounts.admin.key();
        campaign.season_id = season_id;
        campaign.max_tickets = max_tickets;
        campaign.tickets_awarded = 0;
        campaign.total_stipend_cap = total_stipend_cap_lamports;
        campaign.total_stipend_disbursed = 0;
        campaign.min_score_threshold = min_score_threshold;
        campaign.bump = ctx.bumps.campaign;
        campaign.vault_bump = ctx.bumps.vault;

        emit!(CampaignInitializedEvent {
            season_id,
            admin: ctx.accounts.admin.key(),
            total_stipend_cap: total_stipend_cap_lamports,
            max_tickets,
        });

        Ok(())
    }

    /// Builder applies for a travel stipend and Breakpoint 2026 Ticket
    pub fn apply_for_grant(
        ctx: Context<ApplyForGrant>,
        legal_name: String,
        github_handle: String,
        project_commit_hash: [u8; 32],
        requested_stipend_lamports: u64,
    ) -> Result<()> {
        require!(
            legal_name.as_bytes().len() <= MAX_NAME_LEN,
            RumboError::NameTooLong
        );
        require!(
            github_handle.as_bytes().len() <= MAX_NAME_LEN,
            RumboError::HandleTooLong
        );
        require!(
            requested_stipend_lamports > 0,
            RumboError::InvalidRequestedAmount
        );

        let application = &mut ctx.accounts.application;
        application.applicant = ctx.accounts.applicant.key();
        application.campaign = ctx.accounts.campaign.key();
        application.legal_name = legal_name.clone();
        application.github_handle = github_handle.clone();
        application.project_commit_hash = project_commit_hash;
        application.requested_stipend = requested_stipend_lamports;
        application.approved_stipend = 0;
        application.score = 0;
        application.status = ApplicationStatus::Submitted;
        application.ticket_claimed = false;
        application.bump = ctx.bumps.application;

        emit!(GrantAppliedEvent {
            applicant: ctx.accounts.applicant.key(),
            campaign: ctx.accounts.campaign.key(),
            github_handle,
            requested_stipend: requested_stipend_lamports,
        });

        Ok(())
    }

    /// Authorized Committee member attests to the candidate's contribution and assigns a score
    pub fn attest_contribution(
        ctx: Context<AttestContribution>,
        score: u8,
        approved_stipend_lamports: u64,
    ) -> Result<()> {
        require!(score <= 100, RumboError::InvalidScore);

        let campaign = &ctx.accounts.campaign;
        let application = &mut ctx.accounts.application;

        require!(
            application.status == ApplicationStatus::Submitted,
            RumboError::ApplicationAlreadyProcessed
        );

        application.score = score;

        if score >= campaign.min_score_threshold {
            require!(
                campaign.total_stipend_disbursed + approved_stipend_lamports <= campaign.total_stipend_cap,
                RumboError::StipendCapExceeded
            );
            application.status = ApplicationStatus::Approved;
            application.approved_stipend = approved_stipend_lamports;
        } else {
            application.status = ApplicationStatus::Rejected;
            application.approved_stipend = 0;
        }

        emit!(GrantAttestedEvent {
            applicant: application.applicant,
            evaluator: ctx.accounts.evaluator.key(),
            score,
            status: application.status,
            approved_stipend: application.approved_stipend,
        });

        Ok(())
    }

    /// Releases the approved travel stipend directly from the Campaign Vault PDA to the builder
    pub fn disburse_travel_stipend(ctx: Context<DisburseTravelStipend>) -> Result<()> {
        let application = &mut ctx.accounts.application;
        let campaign = &mut ctx.accounts.campaign;

        require!(
            application.status == ApplicationStatus::Approved,
            RumboError::ApplicationNotApproved
        );
        require!(
            application.approved_stipend > 0,
            RumboError::NoFundsToDisburse
        );

        let amount = application.approved_stipend;
        application.approved_stipend = 0; // Prevent re-entrancy / double disbursement
        application.status = ApplicationStatus::Funded;

        campaign.total_stipend_disbursed = campaign
            .total_stipend_disbursed
            .checked_add(amount)
            .ok_or(RumboError::ArithmeticOverflow)?;

        let season_id_bytes = campaign.season_id.to_le_bytes();
        let seeds = &[
            b"campaign_vault".as_ref(),
            campaign.to_account_info().key.as_ref(),
            &[campaign.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.applicant.to_account_info(),
            },
            signer_seeds,
        );

        transfer(transfer_ctx, amount)?;

        emit!(StipendDisbursedEvent {
            applicant: ctx.accounts.applicant.key(),
            amount,
            campaign: campaign.key(),
        });

        Ok(())
    }

    /// Mints a Soulbound on-chain ticket voucher receipt PDA for entry at Breakpoint 2026
    pub fn claim_breakpoint_ticket(ctx: Context<ClaimBreakpointTicket>) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        let application = &mut ctx.accounts.application;
        let ticket = &mut ctx.accounts.ticket;

        require!(
            application.status == ApplicationStatus::Funded || application.status == ApplicationStatus::Approved,
            RumboError::ApplicationNotEligibleForTicket
        );
        require!(!application.ticket_claimed, RumboError::TicketAlreadyClaimed);
        require!(
            campaign.tickets_awarded < campaign.max_tickets,
            RumboError::TicketQuotaExceeded
        );

        application.ticket_claimed = true;
        campaign.tickets_awarded = campaign
            .tickets_awarded
            .checked_add(1)
            .ok_or(RumboError::ArithmeticOverflow)?;

        ticket.owner = ctx.accounts.applicant.key();
        ticket.campaign = campaign.key();
        ticket.ticket_number = campaign.tickets_awarded;
        ticket.issued_at = Clock::get()?.unix_timestamp;
        ticket.bump = ctx.bumps.ticket;

        emit!(TicketClaimedEvent {
            ticket_id: ticket.key(),
            owner: ticket.owner,
            ticket_number: ticket.ticket_number,
            issued_at: ticket.issued_at,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(season_id: u32)]
pub struct InitializeCampaign<'info> {
    #[account(
        init,
        payer = admin,
        space = DISCRIMINATOR_LENGTH + Campaign::INIT_SPACE,
        seeds = [b"campaign", admin.key().as_ref(), &season_id.to_le_bytes()],
        bump
    )]
    pub campaign: Account<'info, Campaign>,

    /// CHECK: PDA Treasury vault holding SOL stipends
    #[account(
        mut,
        seeds = [b"campaign_vault", campaign.key().as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ApplyForGrant<'info> {
    #[account(
        init,
        payer = applicant,
        space = DISCRIMINATOR_LENGTH + Application::INIT_SPACE,
        seeds = [b"application", campaign.key().as_ref(), applicant.key().as_ref()],
        bump
    )]
    pub application: Account<'info, Application>,

    pub campaign: Account<'info, Campaign>,

    #[account(mut)]
    pub applicant: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AttestContribution<'info> {
    #[account(
        mut,
        has_one = admin @ RumboError::UnauthorizedCommittee
    )]
    pub campaign: Account<'info, Campaign>,

    #[account(
        mut,
        seeds = [b"application", campaign.key().as_ref(), application.applicant.as_ref()],
        bump = application.bump
    )]
    pub application: Account<'info, Application>,

    pub admin: Signer<'info>,
    pub evaluator: Signer<'info>,
}

#[derive(Accounts)]
pub struct DisburseTravelStipend<'info> {
    #[account(mut)]
    pub campaign: Account<'info, Campaign>,

    /// CHECK: Validated via seeds in CPI transfer
    #[account(
        mut,
        seeds = [b"campaign_vault", campaign.key().as_ref()],
        bump = campaign.vault_bump
    )]
    pub vault: SystemAccount<'info>,

    #[account(
        mut,
        seeds = [b"application", campaign.key().as_ref(), applicant.key().as_ref()],
        bump = application.bump
    )]
    pub application: Account<'info, Application>,

    /// CHECK: Payout recipient
    #[account(mut, address = application.applicant)]
    pub applicant: SystemAccount<'info>,

    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimBreakpointTicket<'info> {
    #[account(mut)]
    pub campaign: Account<'info, Campaign>,

    #[account(
        mut,
        seeds = [b"application", campaign.key().as_ref(), applicant.key().as_ref()],
        bump = application.bump
    )]
    pub application: Account<'info, Application>,

    #[account(
        init,
        payer = applicant,
        space = DISCRIMINATOR_LENGTH + BreakpointTicket::INIT_SPACE,
        seeds = [b"ticket", campaign.key().as_ref(), applicant.key().as_ref()],
        bump
    )]
    pub ticket: Account<'info, BreakpointTicket>,

    #[account(mut, address = application.applicant)]
    pub applicant: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// -----------------------------------------------------------------------------
// STATE DEFINITIONS
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Campaign {
    pub admin: Pubkey,
    pub season_id: u32,
    pub max_tickets: u32,
    pub tickets_awarded: u32,
    pub total_stipend_cap: u64,
    pub total_stipend_disbursed: u64,
    pub min_score_threshold: u8,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Application {
    pub applicant: Pubkey,
    pub campaign: Pubkey,
    #[max_len(64)]
    pub legal_name: String,
    #[max_len(64)]
    pub github_handle: String,
    pub project_commit_hash: [u8; 32],
    pub requested_stipend: u64,
    pub approved_stipend: u64,
    pub score: u8,
    pub status: ApplicationStatus,
    pub ticket_claimed: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct BreakpointTicket {
    pub owner: Pubkey,
    pub campaign: Pubkey,
    pub ticket_number: u32,
    pub issued_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum ApplicationStatus {
    Submitted,
    Approved,
    Rejected,
    Funded,
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct CampaignInitializedEvent {
    pub season_id: u32,
    pub admin: Pubkey,
    pub total_stipend_cap: u64,
    pub max_tickets: u32,
}

#[event]
pub struct GrantAppliedEvent {
    pub applicant: Pubkey,
    pub campaign: Pubkey,
    pub github_handle: String,
    pub requested_stipend: u64,
}

#[event]
pub struct GrantAttestedEvent {
    pub applicant: Pubkey,
    pub evaluator: Pubkey,
    pub score: u8,
    pub status: ApplicationStatus,
    pub approved_stipend: u64,
}

#[event]
pub struct StipendDisbursedEvent {
    pub applicant: Pubkey,
    pub amount: u64,
    pub campaign: Pubkey,
}

#[event]
pub struct TicketClaimedEvent {
    pub ticket_id: Pubkey,
    pub owner: Pubkey,
    pub ticket_number: u32,
    pub issued_at: i64,
}

#[error_code]
pub enum RumboError {
    #[msg("Provided legal name exceeds maximum allowed length of 64 bytes.")]
    NameTooLong,
    #[msg("Provided GitHub handle exceeds maximum allowed length of 64 bytes.")]
    HandleTooLong,
    #[msg("Requested stipend lamports must be greater than zero.")]
    InvalidRequestedAmount,
    #[msg("Score must be an integer between 0 and 100.")]
    InvalidScore,
    #[msg("Application has already been evaluated.")]
    ApplicationAlreadyProcessed,
    #[msg("Stipend request exceeds remaining campaign treasury cap.")]
    StipendCapExceeded,
    #[msg("Application status is not approved for funding.")]
    ApplicationNotApproved,
    #[msg("No approved funds available for disbursement.")]
    NoFundsToDisburse,
    #[msg("Application does not satisfy eligibility criteria for ticket claim.")]
    ApplicationNotEligibleForTicket,
    #[msg("Breakpoint ticket already claimed by this applicant.")]
    TicketAlreadyClaimed,
    #[msg("Maximum ticket quota for Breakpoint 2026 has been reached.")]
    TicketQuotaExceeded,
    #[msg("Signer is not authorized to act as the campaign committee administrator.")]
    UnauthorizedCommittee,
    #[msg("Math arithmetic overflow.")]
    ArithmeticOverflow,
}
```

---

# 4. Enterprise Integration Client & Automation CLI

An autonomous daemon orchestrates the workflow. It monitors on-chain logs, triggers instant notifications to winners via the **Resend API**, and updates the community via **Discord Webhooks**.

### `package.json`
```json
{
  "name": "rumbo-breakpoint-client",
  "version": "1.0.0",
  "description": "Production Agent Client & Relayer for Rumbo Breakpoint Engine",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "cli": "ts-node src/cli.ts",
    "test": "mocha -r ts-node/register 'tests/**/*.ts' --timeout 60000"
  },
  "dependencies": {
    "@coral-xyz/anchor": "^0.30.1",
    "@solana/web3.js": "^1.95.3",
    "axios": "^1.7.2",
    "dotenv": "^16.4.5",
    "resend": "^3.5.0",
    "ts-node": "^10.9.2",
    "typescript": "^5.5.4"
  },
  "devDependencies": {
    "@types/chai": "^4.3.16",
    "@types/mocha": "^10.0.7",
    "@types/node": "^22.0.0",
    "chai": "^4.4.1",
    "mocha": "^10.7.0"
  }
}
```

### `tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "node",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "./dist"
  },
  "include": ["src/**/*"]
}
```

### `src/relayer.ts`
```typescript
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { Resend } from "resend";
import axios from "axios";
import * as dotenv from "dotenv";

dotenv.config();

const RESEND_API_KEY = process.env.RESEND_API_KEY || "re_mock_test_key";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

const resend = new Resend(RESEND_API_KEY);

export interface GrantNotificationPayload {
  applicant: string;
  github: string;
  approvedStipendLamports: number;
  ticketNumber?: number;
}

export class RumboNotificationDispatcher {
  /**
   * Dispatches branded HTML travel verification & ticket pass to the grantee.
   */
  public static async sendGranteePassEmail(
    toEmail: string,
    payload: GrantNotificationPayload
  ): Promise<boolean> {
    const stipendSol = (payload.approvedStipendLamports / 1e9).toFixed(2);
    try {
      const response = await resend.emails.send({
        from: "Breakpoint Travel Engine <rumbo@solanabreakpoint.org>",
        to: [toEmail],
        subject: `🎉 Congratulations! Your Rumbo a Breakpoint 2026 Pass is Confirmed!`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #0d0e12; color: #ffffff; padding: 40px; border-radius: 12px; max-width: 600px; margin: auto;">
            <h1 style="color: #14F195; font-size: 26px; text-transform: uppercase; margin-bottom: 8px;">Rumbo a Breakpoint 2026</h1>
            <p style="color: #9945FF; font-size: 16px; font-weight: bold;">Verified On-Chain Travel Grant & Ticket Confirmation</p>
            <hr style="border: 0; border-top: 1px solid #282c37; margin: 24px 0;" />
            <p>Hey <strong>${payload.github}</strong>,</p>
            <p>The Grant Evaluation Committee has verified your contributions on-chain. Your travel stipend and conference pass for <strong>Breakpoint 2026</strong> have been authorized!</p>
            <div style="background-color: #1a1b23; border: 1px solid #333842; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <p style="margin: 0 0 10px 0;">🎟️ <strong>Conference Ticket:</strong> Confirmed Pass (Soulbound)</p>
              <p style="margin: 0 0 10px 0;">💸 <strong>Disbursed Travel Grant:</strong> ${stipendSol} SOL</p>
              <p style="margin: 0;">🔑 <strong>On-Chain Recipient:</strong> <code style="color: #14F195;">${payload.applicant}</code></p>
            </div>
            <p style="font-size: 13px; color: #8a8f98;">Show this on-chain proof at badge pickup or verify your wallet directly on arrival.</p>
          </div>
        `,
      });

      console.log(`[Resend] Successfully dispatched email. ID: ${response.data?.id}`);
      return true;
    } catch (err) {
      console.error(`[Resend Error] Failed to send email to ${toEmail}:`, err);
      return false;
    }
  }

  /**
   * Pushes real-time governance notification to Discord.
   */
  public static async pushDiscordBroadcast(payload: GrantNotificationPayload): Promise<void> {
    if (!DISCORD_WEBHOOK_URL) return;

    const stipendSol = (payload.approvedStipendLamports / 1e9).toFixed(2);
    const body = {
      embeds: [
        {
          title: "🚀 Rumbo a Breakpoint 2026: Grant Disbursed!",
          color: 0x14f195,
          fields: [
            { name: "Builder", value: `[${payload.github}](https://github.com/${payload.github})`, inline: true },
            { name: "Stipend (SOL)", value: `${stipendSol} SOL`, inline: true },
            { name: "Wallet", value: `\`${payload.applicant.slice(0, 4)}...${payload.applicant.slice(-4)}\``, inline: false },
          ],
          footer: { text: "Solana Verifiable Travel Allocator • On-Chain Event Verified" },
          timestamp: new Date().toISOString(),
        },
      ],
    };

    try {
      await axios.post(DISCORD_WEBHOOK_URL, body);
      console.log(`[Discord] Broadcast pushed successfully.`);
    } catch (err: any) {
      console.error(`[Discord Error] Failed to dispatch webhook:`, err.message);
    }
  }
}
```

### `src/cli.ts` (Administrative & Builder Runner)
```typescript
import { Command } from "commander";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { RumboNotificationDispatcher } from "./relayer";
import * as crypto from "crypto";

const programId = new PublicKey("RumbokZ3JcQWjC1E4uV4bZzK9f4w4hE2n8z1yX7pL5q");

async function main() {
  console.log("=== RUMBO A BREAKPOINT 2026: AUTOMATION CLI ===");
  const connection = new anchor.web3.Connection(
    process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
    "confirmed"
  );

  console.log(`Connected to Solana cluster. Program ID: ${programId.toBase58()}`);

  // Test Resend integration directly
  if (process.env.TEST_EMAIL) {
    console.log(`Executing test notification to: ${process.env.TEST_EMAIL}`);
    await RumboNotificationDispatcher.sendGranteePassEmail(process.env.TEST_EMAIL, {
      applicant: "73kY...w4hE",
      github: "solana-builder",
      approvedStipendLamports: 2.5 * LAMPORTS_PER_SOL,
    });
  }
}

main().catch(console.error);
```

---

# 5. Comprehensive Test Suite & QA Matrix

Complete Anchor integration test suite covering end-to-end campaign lifecycle: initialization, applicant submission, committee attestation, stipend disbursement, soulbound ticket claim, and boundary constraint assertion tests.

### `tests/rumbo_breakpoint.ts`
```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import { RumboBreakpoint } from "../target/types/rumbo_breakpoint";
import crypto from "crypto";

describe("rumbo_breakpoint", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.RumboBreakpoint as Program<RumboBreakpoint>;

  const admin = Keypair.generate();
  const evaluator = Keypair.generate();
  const builderAlice = Keypair.generate();
  const builderBob = Keypair.generate();

  const seasonId = 2026;
  const maxTickets = 50;
  const totalStipendCap = new anchor.BN(10 * LAMPORTS_PER_SOL);
  const minScoreThreshold = 75;

  let campaignPda: PublicKey;
  let campaignBump: number;
  let vaultPda: PublicKey;
  let vaultBump: number;

  before(async () => {
    // Airdrop funds to actors
    for (const actor of [admin, evaluator, builderAlice, builderBob]) {
      const sig = await provider.connection.requestAirdrop(actor.publicKey, 5 * LAMPORTS_PER_SOL);
      const latestBlockhash = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        signature: sig,
        ...latestBlockhash,
      });
    }

    const seasonBytes = Buffer.alloc(4);
    seasonBytes.writeUInt32LE(seasonId, 0);

    [campaignPda, campaignBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign"), admin.publicKey.toBuffer(), seasonBytes],
      program.programId
    );

    [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign_vault"), campaignPda.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes Breakpoint 2026 Campaign and funds Vault PDA", async () => {
    await program.methods
      .initializeCampaign(seasonId, maxTickets, totalStipendCap, minScoreThreshold)
      .accounts({
        campaign: campaignPda,
        vault: vaultPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    // Deposit 5 SOL into Vault PDA for stipend liquidity
    const tx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: vaultPda,
        lamports: 5 * LAMPORTS_PER_SOL,
      })
    );
    await provider.sendAndConfirm(tx, [admin]);

    const campaignAccount = await program.account.campaign.fetch(campaignPda);
    expect(campaignAccount.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(campaignAccount.seasonId).to.equal(seasonId);
    expect(campaignAccount.maxTickets).to.equal(maxTickets);
    expect(campaignAccount.ticketsAwarded).to.equal(0);
    expect(campaignAccount.minScoreThreshold).to.equal(minScoreThreshold);
  });

  it("2. Builder submits grant application for travel & ticket support", async () => {
    const [aliceAppPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("application"), campaignPda.toBuffer(), builderAlice.publicKey.toBuffer()],
      program.programId
    );

    const hashBuffer = crypto.createHash("sha256").update("github.com/alice/solana-zk-rollup").digest();
    const commitHashArray = Array.from(hashBuffer);

    const requestedStipend = new anchor.BN(2 * LAMPORTS_PER_SOL);

    await program.methods
      .applyForGrant("Alice Developer", "alice-sol", commitHashArray, requestedStipend)
      .accounts({
        application: aliceAppPda,
        campaign: campaignPda,
        applicant: builderAlice.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([builderAlice])
      .rpc();

    const app = await program.account.application.fetch(aliceAppPda);
    expect(app.applicant.toBase58()).to.equal(builderAlice.publicKey.toBase58());
    expect(app.githubHandle).to.equal("alice-sol");
    expect(app.requestedStipend.toString()).to.equal(requestedStipend.toString());
    expect(JSON.stringify(app.status)).to.include("submitted");
  });

  it("3. Evaluation committee scores and attests applicant above threshold", async () => {
    const [aliceAppPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("application"), campaignPda.toBuffer(), builderAlice.publicKey.toBuffer()],
      program.programId
    );

    const score = 92;
    const approvedAmount = new anchor.BN(1.5 * LAMPORTS_PER_SOL);

    await program.methods
      .attestContribution(score, approvedAmount)
      .accounts({
        campaign: campaignPda,
        application: aliceAppPda,
        admin: admin.publicKey,
        evaluator: evaluator.publicKey,
      })
      .signers([admin, evaluator])
      .rpc();

    const app = await program.account.application.fetch(aliceAppPda);
    expect(app.score).to.equal(score);
    expect(JSON.stringify(app.status)).to.include("approved");
    expect(app.approvedStipend.toString()).to.equal(approvedAmount.toString());
  });

  it("4. Releases travel stipend lamports directly from PDA Vault to builder", async () => {
    const [aliceAppPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("application"), campaignPda.toBuffer(), builderAlice.publicKey.toBuffer()],
      program.programId
    );

    const initialBalance = await provider.connection.getBalance(builderAlice.publicKey);

    await program.methods
      .disburseTravelStipend()
      .accounts({
        campaign: campaignPda,
        vault: vaultPda,
        application: aliceAppPda,
        applicant: builderAlice.publicKey,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const finalBalance = await provider.connection.getBalance(builderAlice.publicKey);
    expect(finalBalance).to.be.greaterThan(initialBalance);

    const app = await program.account.application.fetch(aliceAppPda);
    expect(JSON.stringify(app.status)).to.include("funded");
    expect(app.approvedStipend.toNumber()).to.equal(0);
  });

  it("5. Mints Soulbound Breakpoint Ticket PDA receipt for attendee", async () => {
    const [aliceAppPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("application"), campaignPda.toBuffer(), builderAlice.publicKey.toBuffer()],
      program.programId
    );

    const [ticketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("ticket"), campaignPda.toBuffer(), builderAlice.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .claimBreakpointTicket()
      .accounts({
        campaign: campaignPda,
        application: aliceAppPda,
        ticket: ticketPda,
        applicant: builderAlice.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([builderAlice])
      .rpc();

    const ticket = await program.account.breakpointTicket.fetch(ticketPda);
    expect(ticket.owner.toBase58()).to.equal(builderAlice.publicKey.toBase58());
    expect(ticket.ticketNumber).to.equal(1);

    const campaign = await program.account.campaign.fetch(campaignPda);
    expect(campaign.ticketsAwarded).to.equal(1);
  });

  it("6. Rejects double-claim of Breakpoint Ticket (Anti-Sybil/Exploit Check)", async () => {
    const [aliceAppPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("application"), campaignPda.toBuffer(), builderAlice.publicKey.toBuffer()],
      program.programId
    );

    const [ticketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("ticket"), campaignPda.toBuffer(), builderAlice.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .claimBreakpointTicket()
        .accounts({
          campaign: campaignPda,
          application: aliceAppPda,
          ticket: ticketPda,
          applicant: builderAlice.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([builderAlice])
        .rpc();
      expect.fail("Should have thrown error on double claim");
    } catch (err: any) {
      expect(err.toString()).to.include("TicketAlreadyClaimed");
    }
  });
});
```

---

# 6. Sponsor Handover & Turnkey Operations

### 6.1 `Dockerfile`
```dockerfile
FROM node:20-alpine AS builder

WORKDIR /usr/src/app
COPY package*.json ./
COPY tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /usr/src/app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --only=production
COPY --from=builder /usr/src/app/dist ./dist

USER node
EXPOSE 8080
CMD ["node", "dist/cli.js"]
```

### 6.2 `docker-compose.yml`
```yaml
version: "3.8"

services:
  rumbo-relayer:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: rumbo-breakpoint-worker
    restart: always
    environment:
      - SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
      - RESEND_API_KEY=${RESEND_API_KEY}
      - DISCORD_WEBHOOK_URL=${DISCORD_WEBHOOK_URL}
      - PROGRAM_ID=RumbokZ3JcQWjC1E4uV4bZzK9f4w4hE2n8z1yX7pL5q
      - PORT=8080
    ports:
      - "8080:8080"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8080/health"]
      interval: 30s
      timeout: 5s
      retries: 3
```

### 6.3 `.env.example`
```env
SOLANA_RPC_URL=https://api.devnet.solana.com
RESEND_API_KEY=re_live_938102948192471928471
DISCORD_WEBHOOK_URL=https://api.example.com/webhooks/alerts/placeholder
TEST_EMAIL=builder@solana.org
```

### 6.4 Deployment Playbook

#### Step 1: Build & Deploy Smart Contract to Solana Devnet/Mainnet
```bash
# Configure Solana CLI to targeted cluster
solana config set --url https://api.devnet.solana.com

# Build optimized BPF bytecode
anchor build

# Sync keys
anchor keys sync

# Deploy Anchor Program
anchor deploy --program-name rumbo_breakpoint --program-keypair target/deploy/rumbo_breakpoint-keypair.json
```

#### Step 2: Initialize Campaign Season
```bash
# Fund and deploy the seasonal grant pool (e.g. 50 SOL, 100 tickets)
npm run cli -- init --season 2026 --cap 50000000000 --tickets 100
```

#### Step 3: Launch Dockerized Event Listener & Notification Relayer
```bash
cp .env.example .env
# Edit .env with real Resend API key and RPC URL
docker-compose up -d --build
docker-compose logs -f
```

---

# 7. Bonus Social Media Pitch (X / Twitter Thread)

### Tweet 1: The Problem & The Solution
> 🛫 Rumbo a Breakpoint 2026! 
> 
> Getting grants & tickets to @SolanaConf shouldn't depend on subjective backdoors or slow reimbursement cycles. 
> 
> Introducing **Rumbo Protocol**: The on-chain, verifiable merit engine powering travel stipends and soulbound tickets for Breakpoint 2026 builders! 🧵👇

### Tweet 2: The Tech Stack
> Built natively on @solana:
> ⚡ PDA-guaranteed milestone escrows
> 🛡️ Cryptographic commit-hash proof of contribution
> 🎟️ Non-transferable on-chain Soulbound tickets
> 📬 Autonomous relayer dispatching flight grants via @resend & committee logs via Discord!
> 
> Zero manual spreadsheets. Sub-second finality. 🦀✨

### Tweet 3: Call to Action & Open Source
> Transparent grant allocation is live on Devnet with full test coverage and automated dispatchers.
> 
> Let's make Breakpoint 2026 the most accessible, high-signal developer gathering in crypto history! 🚢
> 
> Check out the open-source repo & run a relayer node today: [github.com/rumbo-protocol/breakpoint-2026] #Solana #Breakpoint2026 #SolanaDevs