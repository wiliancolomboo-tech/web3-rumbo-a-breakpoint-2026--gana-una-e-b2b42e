use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("BkpPass111111111111111111111111111111111111");

#[program]
pub mod breakpoint_pass {
    use super::*;

    pub fn initialize_campaign(
        ctx: Context<InitializeCampaign>,
        name: String,
        grant_amount_per_builder: u64,
        total_tickets_available: u32,
        deadline: i64,
    ) -> Result<()> {
        instructions::initialize_campaign::handler(ctx, name, grant_amount_per_builder, total_tickets_available, deadline)
    }

    pub fn deposit_funds(ctx: Context<DepositFunds>, amount: u64) -> Result<()> {
        instructions::deposit_funds::handler(ctx, amount)
    }

    pub fn apply_grant(
        ctx: Context<ApplyGrant>,
        github_handle: String,
        proof_url: String,
    ) -> Result<()> {
        instructions::apply_grant::handler(ctx, github_handle, proof_url)
    }

    pub fn attest_and_score(ctx: Context<AttestAndScore>, score: u8) -> Result<()> {
        instructions::attest_and_score::handler(ctx, score)
    }

    pub fn claim_grant_and_ticket(ctx: Context<ClaimGrantAndTicket>) -> Result<()> {
        instructions::claim_grant_and_ticket::handler(ctx)
    }
}