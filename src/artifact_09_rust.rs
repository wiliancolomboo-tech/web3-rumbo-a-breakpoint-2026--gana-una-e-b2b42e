use anchor_lang::prelude::*;
use crate::state::{ScholarshipRound, ApplicantRecord, ReviewRecord, ScholarStatus};
use crate::errors::RumboError;

#[derive(Accounts)]
pub struct SubmitReview<'info> {
    #[account(
        seeds = [b"round", round.round_id.to_le_bytes().as_ref()],
        bump = round.bump
    )]
    pub round: Account<'info, ScholarshipRound>,

    #[account(
        mut,
        seeds = [b"applicant", round.key().as_ref(), applicant_record.applicant.as_ref()],
        bump = applicant_record.bump
    )]
    pub applicant_record: Account<'info, ApplicantRecord>,

    #[account(
        init,
        payer = reviewer,
        space = ReviewRecord::LEN,
        seeds = [b"review", applicant_record.key().as_ref(), reviewer.key().as_ref()],
        bump
    )]
    pub review_record: Account<'info, ReviewRecord>,

    #[account(mut)]
    pub reviewer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_submit_review(
    ctx: Context<SubmitReview>,
    score: u8,
) -> Result<()> {
    require!(score >= 1 && score <= 100, RumboError::InvalidScoreRange);

    let applicant_record = &mut ctx.accounts.applicant_record;
    require!(
        applicant_record.status == ScholarStatus::Applied || applicant_record.status == ScholarStatus::UnderReview,
        RumboError::InvalidApplicantStatus
    );

    applicant_record.score_sum = applicant_record.score_sum.checked_add(score as u32).ok_or(RumboError::MathOverflow)?;
    applicant_record.review_count = applicant_record.review_count.checked_add(1).ok_or(RumboError::MathOverflow)?;
    applicant_record.status = ScholarStatus::UnderReview;

    let review_record = &mut ctx.accounts.review_record;
    review_record.applicant = applicant_record.applicant;
    review_record.reviewer = ctx.accounts.reviewer.key();
    review_record.score = score;
    review_record.bump = ctx.bumps.review_record;

    Ok(())
}