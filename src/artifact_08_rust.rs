use anchor_lang::prelude::*;
use crate::state::{ScholarshipRound, ApplicantRecord, ScholarStatus};
use crate::errors::RumboError;

#[derive(Accounts)]
pub struct ApplyScholarship<'info> {
    #[account(
        mut,
        seeds = [b"round", round.round_id.to_le_bytes().as_ref()],
        bump = round.bump
    )]
    pub round: Account<'info, ScholarshipRound>,

    #[account(
        init,
        payer = applicant,
        space = ApplicantRecord::LEN,
        seeds = [b"applicant", round.key().as_ref(), applicant.key().as_ref()],
        bump
    )]
    pub applicant_record: Account<'info, ApplicantRecord>,

    #[account(mut)]
    pub applicant: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_apply(
    ctx: Context<ApplyScholarship>,
    ipfs_metadata_hash: [u8; 32],
) -> Result<()> {
    let round = &mut ctx.accounts.round;
    require!(round.is_active, RumboError::RoundNotActive);

    let clock = Clock::get()?;
    require!(clock.unix_timestamp <= round.application_deadline, RumboError::DeadlineExceeded);

    let applicant_record = &mut ctx.accounts.applicant_record;
    applicant_record.applicant = ctx.accounts.applicant.key();
    applicant_record.round_id = round.round_id;
    applicant_record.ipfs_metadata_hash = ipfs_metadata_hash;
    applicant_record.score_sum = 0;
    applicant_record.review_count = 0;
    applicant_record.status = ScholarStatus::Applied;
    applicant_record.tranche_1_lamports = round.grant_amount_per_scholar / 2;
    applicant_record.tranche_2_lamports = round.grant_amount_per_scholar
        .checked_sub(applicant_record.tranche_1_lamports)
        .ok_or(RumboError::MathOverflow)?;
    applicant_record.bump = ctx.bumps.applicant_record;

    round.total_applicants = round.total_applicants.checked_add(1).ok_or(RumboError::MathOverflow)?;
    Ok(())
}