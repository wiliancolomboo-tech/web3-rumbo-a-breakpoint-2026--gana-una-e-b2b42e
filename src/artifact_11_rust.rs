use anchor_lang::prelude::*;
use crate::state::{GlobalConfig, ScholarshipRound, ApplicantRecord, ScholarStatus};
use crate::errors::RumboError;

#[derive(Accounts)]
pub struct ClaimTranche1<'info> {
    #[account(
        seeds = [b"round", round.round_id.to_le_bytes().as_ref()],
        bump = round.bump
    )]
    pub round: Account<'info, ScholarshipRound>,

    #[account(
        mut,
        seeds = [b"applicant", round.key().as_ref(), applicant.key().as_ref()],
        bump = applicant_record.bump,
        has_one = applicant
    )]
    pub applicant_record: Account<'info, ApplicantRecord>,

    /// CHECK: PDA Escrow holding grant funds
    #[account(
        mut,
        seeds = [b"vault", round.key().as_ref()],
        bump = round.vault_bump
    )]
    pub escrow_vault: SystemAccount<'info>,

    #[account(mut)]
    pub applicant: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimTranche2<'info> {
    #[account(
        seeds = [b"global_config"],
        bump = global_config.bump
    )]
    pub global_config: Account<'info, GlobalConfig>,

    #[account(
        seeds = [b"round", round.round_id.to_le_bytes().as_ref()],
        bump = round.bump
    )]
    pub round: Account<'info, ScholarshipRound>,

    #[account(
        mut,
        seeds = [b"applicant", round.key().as_ref(), applicant.key().as_ref()],
        bump = applicant_record.bump,
        has_one = applicant
    )]
    pub applicant_record: Account<'info, ApplicantRecord>,

    /// CHECK: PDA Escrow holding grant funds
    #[account(
        mut,
        seeds = [b"vault", round.key().as_ref()],
        bump = round.vault_bump
    )]
    pub escrow_vault: SystemAccount<'info>,

    pub checkin_authority: Signer<'info>,

    #[account(mut)]
    pub applicant: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_claim_tranche_1(ctx: Context<ClaimTranche1>) -> Result<()> {
    let applicant_record = &mut ctx.accounts.applicant_record;
    require!(applicant_record.status == ScholarStatus::Approved, RumboError::InvalidApplicantStatus);

    let amount = applicant_record.tranche_1_lamports;
    require!(
        **ctx.accounts.escrow_vault.to_account_info().lamports.borrow() >= amount,
        RumboError::InsufficientVaultFunds
    );

    **ctx.accounts.escrow_vault.to_account_info().try_borrow_mut_lamports()? -= amount;
    **ctx.accounts.applicant.to_account_info().try_borrow_mut_lamports()? += amount;

    applicant_record.status = ScholarStatus::Tranche1Disbursed;
    Ok(())
}

pub fn handle_claim_tranche_2(ctx: Context<ClaimTranche2>) -> Result<()> {
    let global_config = &ctx.accounts.global_config;
    require!(
        ctx.accounts.checkin_authority.key() == global_config.checkin_oracle,
        RumboError::UnauthorizedSigner
    );

    let applicant_record = &mut ctx.accounts.applicant_record;
    require!(
        applicant_record.status == ScholarStatus::Tranche1Disbursed,
        RumboError::Tranche1NotClaimed
    );

    let amount = applicant_record.tranche_2_lamports;
    require!(
        **ctx.accounts.escrow_vault.to_account_info().lamports.borrow() >= amount,
        RumboError::InsufficientVaultFunds
    );

    **ctx.accounts.escrow_vault.to_account_info().try_borrow_mut_lamports()? -= amount;
    **ctx.accounts.applicant.to_account_info().try_borrow_mut_lamports()? += amount;

    applicant_record.status = ScholarStatus::FullyCompleted;
    Ok(())
}