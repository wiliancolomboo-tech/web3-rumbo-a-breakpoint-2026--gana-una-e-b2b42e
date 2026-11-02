use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("RumboxQx6Zt3K6m1pB4uTfV2YvN8WpZ9cDeFgHjK1Mn");

#[program]
pub mod rumbo_protocol {
    use super::*;

    pub fn initialize_campaign(
        ctx: Context<InitializeCampaign>,
        title: String,
        total_allocation: u64,
        stipend_per_scholar: u64,
        duration_seconds: i64,
    ) -> Result<()> {
        instructions::initialize_campaign::handler(ctx, title, total_allocation, stipend_per_scholar, duration_seconds)
    }

    pub fn apply_grant(
        ctx: Context<ApplyGrant>,
        handle: String,
        repo_commit_hash: String,
        expected_milestones: u8,
    ) -> Result<()> {
        instructions::apply_grant::handler(ctx, handle, repo_commit_hash, expected_milestones)
    }

    pub fn approve_milestone(ctx: Context<ApproveMilestone>) -> Result<()> {
        instructions::approve_milestone::handler(ctx)
    }

    pub fn claim_travel_stipend(ctx: Context<ClaimTravelStipend>) -> Result<()> {
        instructions::claim_travel_stipend::handler(ctx)
    }
}