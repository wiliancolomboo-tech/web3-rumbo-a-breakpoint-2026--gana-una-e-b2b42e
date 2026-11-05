use anchor_lang::prelude::*;
use crate::state::{ScholarshipRound, ApplicantRecord, ScholarStatus};
use crate::errors::RumboError;

#[derive(Accounts)]
pub struct FinalizeApplicant<'info> {
    #[account(
        mut,
        seeds = [b"round", round.round_id.to_le_bytes().as_ref()],
        bump = round.bump,
        has_one = authority
    )]
    pub round: Account<'info, ScholarshipRound>,

    #[account(
        mut,
        seeds = [b"applicant", round.key().as_ref(), applicant_record.applicant.as_ref()],
        bump = applicant_record.bump
    )]
    pub applicant_record: Account<'info, ApplicantRecord>,

    pub authority: Signer<'info>,
}

pub fn handle_finalize(ctx: Context<FinalizeApplicant>) -> Result<()> {
    let round = &mut ctx.accounts.round;
    let applicant_record = &mut ctx.accounts.applicant_record;

    require!(
        applicant_record.status == ScholarStatus::UnderReview || applicant_record.status == ScholarStatus::Applied,
        RumboError::InvalidApplicantStatus
    );
    require!(
        applicant_record.review_count >= round.min_reviews_required,
        RumboError::QuorumNotMet
    );

    let avg_score = applicant_record.score_sum / (applicant_record.review_count as u32);

    if avg_score >= round.pass_score_threshold as u32 {
        applicant_record.status = ScholarStatus::Approved;
        round.total_approved = round.total_approved.checked_add(1).ok_or(RumboError::MathOverflow)?;
    } else {
        applicant_record.status = ScholarStatus::Rejected;
    }

    Ok(())
}