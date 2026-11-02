use anchor_lang::prelude::*;
use crate::state::{Campaign, Grantee, GranteeStatus};
use crate::errors::RumboError;

#[derive(Accounts)]
pub struct ApplyGrant<'info> {
    #[account(mut)]
    pub scholar: Signer<'info>,

    #[account(
        mut,
        seeds = [b"campaign", campaign.authority.as_ref(), campaign.title.as_bytes()],
        bump = campaign.bump
    )]
    pub campaign: Account<'info, Campaign>,

    #[account(
        init,
        payer = scholar,
        space = 8 + Grantee::INIT_SPACE,
        seeds = [b"grantee", campaign.key().as_ref(), scholar.key().as_ref()],
        bump
    )]
    pub grantee: Account<'info, Grantee>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<ApplyGrant>,
    handle: String,
    repo_commit_hash: String,
    expected_milestones: u8,
) -> Result<()> {
    require!(handle.len() <= 32, RumboError::InputStringTooLong);
    require!(repo_commit_hash.len() <= 64, RumboError::InputStringTooLong);

    let clock = Clock::get()?;
    require!(clock.unix_timestamp < ctx.accounts.campaign.deadline, RumboError::CampaignExpired);

    let campaign = &mut ctx.accounts.campaign;
    let grantee = &mut ctx.accounts.grantee;

    grantee.campaign = campaign.key();
    grantee.scholar = ctx.accounts.scholar.key();
    grantee.stipend_amount = campaign.stipend_per_scholar;
    grantee.milestone_count = expected_milestones;
    grantee.milestones_approved = 0;
    grantee.status = GranteeStatus::Applied;
    grantee.ticket_issued = false;
    grantee.funds_claimed = false;
    grantee.bump = ctx.bumps.grantee;
    grantee.repo_commit_hash = repo_commit_hash;
    grantee.handle = handle;

    campaign.total_grantees = campaign.total_grantees.checked_add(1).ok_or(RumboError::MathOverflow)?;

    msg!("Scholar applied: {} with handle @{}", grantee.scholar, grantee.handle);
    Ok(())
}