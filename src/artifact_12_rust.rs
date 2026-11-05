pub mod errors;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;
use instructions::apply::*;
use instructions::claim_tranche::*;
use instructions::finalize::*;
use instructions::initialize::*;

declare_id!("RumbobReakpo1nt202611111111111111111111111");

#[program]
pub mod rumbo_breakpoint {
    use super::*;

    pub fn initialize_global(ctx: Context<InitializeGlobal>, checkin_oracle: Pubkey) -> Result<()> {
        handle_initialize_global(ctx, checkin_oracle)
    }

    pub fn initialize_round(
        ctx: Context<InitializeRound>,
        round_id: u64,
        grant_amount_per_scholar: u64,
        application_deadline: i64,
        min_reviews_required: u8,
        pass_score_threshold: u8,
    ) -> Result<()> {
        handle_initialize_round(
            ctx,
            round_id,
            grant_amount_per_scholar,
            application_deadline,
            min_reviews_required,
            pass_score_threshold,
        )
    }

    pub fn apply(ctx: Context<ApplyScholarship>, ipfs_metadata_hash: [u8; 32]) -> Result<()> {
        handle_apply(ctx, ipfs_metadata_hash)
    }

    pub fn submit_review(ctx: Context<SubmitReview>, score: u8) -> Result<()> {
        handle_submit_review(ctx, score)
    }

    pub fn finalize(ctx: Context<FinalizeApplicant>) -> Result<()> {
        handle_finalize(ctx)
    }

    pub fn claim_tranche_1(ctx: Context<ClaimTranche1>) -> Result<()> {
        handle_claim_tranche_1(ctx)
    }

    pub fn claim_tranche_2(ctx: Context<ClaimTranche2>) -> Result<()> {
        handle_claim_tranche_2(ctx)
    }
}