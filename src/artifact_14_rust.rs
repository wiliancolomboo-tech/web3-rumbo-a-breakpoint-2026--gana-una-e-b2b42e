use anchor_lang::prelude::*;
use crate::state::{GrantPool, GrantApplication, ApplicationStatus};
use crate::errors::RumboError;
use crate::events::TrancheDisbursed;

#[derive(Accounts)]
pub struct ClaimTrancheOne<'info> {
    #[account(
        mut,
        seeds = [b"pool", pool.pool_id.as_bytes()],
        bump = pool.bump
    )]
    pub pool: Account<'info, GrantPool>,

    /// CHECK: Vault PDA
    #[account(
        mut,
        seeds = [b"vault", pool.key().as_ref()],
        bump = pool.vault_bump
    )]
    pub vault: SystemAccount<'info>,

    #[account(
        mut,
        seeds = [b"application", pool.key().as_ref(), applicant.key().as_ref()],
        bump = application.bump,
        has_one = applicant
    )]
    pub application: Account<'info, GrantApplication>,

    #[account(mut)]
    pub applicant: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ClaimTrancheOne>, ticket_reference_hash: [u8; 32]) -> Result<()> {
    require!(ticket_reference_hash != [0u8; 32], RumboError::InvalidAttestationHash);

    let application = &mut ctx.accounts.application;
    require!(application.status == ApplicationStatus::Approved, RumboError::InvalidApplicationStatus);
    require!(!application.tranche_one_disbursed, RumboError::TrancheOneAlreadyClaimed);

    let pool = &mut ctx.accounts.pool;
    let tranche_amount = (application.approved_amount as u128)
        .checked_mul(pool.tranche_one_pct as u128)
        .unwrap()
        .checked_div(100)
        .unwrap() as u64;

    application.ticket_hash = ticket_reference_hash;
    application.tranche_one_disbursed = true;
    application.status = ApplicationStatus::TrancheOneClaimed;

    pool.disbursed_funds = pool.disbursed_funds.checked_add(tranche_amount).unwrap();

    // PDA transfer native SOL
    let pool_key = pool.key();
    let vault_seeds: &[&[&[u8]]] = &[&[
        b"vault",
        pool_key.as_ref(),
        &[pool.vault_bump],
    ]];

    anchor_lang::system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.applicant.to_account_info(),
            },
            vault_seeds,
        ),
        tranche_amount,
    )?;

    emit!(TrancheDisbursed {
        application: application.key(),
        applicant: application.applicant,
        tranche_index: 1,
        amount: tranche_amount,
    });

    Ok(())
}