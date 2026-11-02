use anchor_lang::prelude::*;
use crate::state::{Campaign, Grantee, GranteeStatus};
use crate::errors::RumboError;

#[derive(Accounts)]
pub struct ApproveMilestone<'info> {
    #[account(
        mut,
        constraint = reviewer.key() == campaign.authority @ RumboError::UnauthorizedReviewer
    )]
    pub reviewer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"campaign", campaign.authority.as_ref(), campaign.title.as_bytes()],
        bump = campaign.bump
    )]
    pub campaign: Account<'info, Campaign>,

    #[account(
        mut,
        seeds = [b"grantee", campaign.key().as_ref(), grantee.scholar.as_ref()],
        bump = grantee.bump,
        constraint = grantee.campaign == campaign.key()
    )]
    pub grantee: Account<'info, Grantee>,
}

#[event]
pub struct MilestoneApprovedEvent {
    pub campaign: Pubkey,
    pub scholar: Pubkey,
    pub milestones_approved: u8,
    pub total_milestones: u8,
    pub is_fully_verified: bool,
}

pub fn handler(ctx: Context<ApproveMilestone>) -> Result<()> {
    let grantee = &mut ctx.accounts.grantee;
    let campaign = &mut ctx.accounts.campaign;

    grantee.milestones_approved = grantee.milestones_approved.checked_add(1).ok_or(RumboError::MathOverflow)?;

    let mut fully_verified = false;
    if grantee.milestones_approved >= grantee.milestone_count {
        grantee.status = GranteeStatus::Verified;
        grantee.ticket_issued = true; // Auto-qualifies for Breakpoint 2026 Ticket
        campaign.approved_grantees = campaign.approved_grantees.checked_add(1).ok_or(RumboError::MathOverflow)?;
        fully_verified = true;
    }

    emit!(MilestoneApprovedEvent {
        campaign: campaign.key(),
        scholar: grantee.scholar,
        milestones_approved: grantee.milestones_approved,
        total_milestones: grantee.milestone_count,
        is_fully_verified: fully_verified,
    });

    msg!(
        "Milestone approved for scholar {}. Progress: {}/{}",
        grantee.scholar,
        grantee.milestones_approved,
        grantee.milestone_count
    );

    Ok(())
}