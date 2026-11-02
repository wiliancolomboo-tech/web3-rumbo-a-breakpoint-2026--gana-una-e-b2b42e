use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("BrkPass1111111111111111111111111111111111111");

#[program]
pub mod breakpoint_pass {
    use super::*;

    pub fn initialize_campaign(
        ctx: Context<InitializeCampaign>,
        campaign_id: u64,
        name: String,
        quorum_required: u8,
        judges: Vec<Pubkey>,
        deadline_ts: i64,
    ) -> Result<()> {
        instructions::initialize_campaign::handler(ctx, campaign_id, name, quorum_required, judges, deadline_ts)
    }

    pub fn approve_grantee(
        ctx: Context<ApproveGrantee>,
        campaign_id: u64,
        grantee_pubkey: Pubkey,
        allocated_stipend: u64,
        ticket_reference_id: [u8; 16],
        milestone_percentages: [u16; 3],
    ) -> Result<()> {
        instructions::approve_grantee::handler(
            ctx,
            campaign_id,
            grantee_pubkey,
            allocated_stipend,
            ticket_reference_id,
            milestone_percentages,
        )
    }

    pub fn attest_milestone(
        ctx: Context<AttestMilestone>,
        milestone_idx: u8,
        submission_hash: [u8; 32],
    ) -> Result<()> {
        instructions::attest_milestone::handler(ctx, milestone_idx, submission_hash)
    }

    pub fn claim_milestone(ctx: Context<ClaimMilestone>, milestone_idx: u8) -> Result<()> {
        instructions::claim_milestone::handler(ctx, milestone_idx)
    }

    pub fn emergency_refund(ctx: Context<EmergencyRefund>) -> Result<()> {
        instructions::emergency_refund::handler(ctx)
    }
}