use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{Campaign, Grantee, GranteeStatus};
use crate::errors::RumboError;

#[derive(Accounts)]
pub struct ClaimTravelStipend<'info> {
    #[account(mut)]
    pub scholar: Signer<'info>,

    #[account(
        mut,
        seeds = [b"campaign", campaign.authority.as_ref(), campaign.title.as_bytes()],
        bump = campaign.bump
    )]
    pub campaign: Account<'info, Campaign>,

    #[account(
        mut,
        seeds = [b"grantee", campaign.key().as_ref(), scholar.key().as_ref()],
        bump = grantee.bump,
        constraint = grantee.scholar == scholar.key(),
        constraint = grantee.campaign == campaign.key()
    )]
    pub grantee: Account<'info, Grantee>,

    #[account(
        mut,
        seeds = [b"vault", campaign.key().as_ref()],
        bump = campaign.vault_bump,
        constraint = vault.key() == campaign.vault
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = scholar_token_account.owner == scholar.key(),
        constraint = scholar_token_account.mint == campaign.token_mint
    )]
    pub scholar_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[event]
pub struct StipendDisbursedEvent {
    pub campaign: Pubkey,
    pub scholar: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

pub fn handler(ctx: Context<ClaimTravelStipend>) -> Result<()> {
    let grantee = &mut ctx.accounts.grantee;
    let campaign = &mut ctx.accounts.campaign;

    require!(
        grantee.status == GranteeStatus::Verified || grantee.milestones_approved >= grantee.milestone_count,
        RumboError::GranteeNotVerified
    );
    require!(!grantee.funds_claimed, RumboError::AlreadyClaimed);
    require!(ctx.accounts.vault.amount >= grantee.stipend_amount, RumboError::InsufficientCampaignVaultFunds);

    let payout_amount = grantee.stipend_amount;
    let campaign_key = campaign.key();
    let vault_seeds = &[
        b"vault".as_ref(),
        campaign_key.as_ref(),
        &[campaign.vault_bump],
    ];
    let signer = &[&vault_seeds[..]];

    // Execute transfer from Campaign Vault PDA to Scholar
    let cpi_accounts = Transfer {
        from: ctx.accounts.vault.to_account_info(),
        to: ctx.accounts.scholar_token_account.to_account_info(),
        authority: ctx.accounts.vault.to_account_info(),
    };
    let cpi_program = ctx.accounts.token_program.to_account_info();
    let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);

    token::transfer(cpi_ctx, payout_amount)?;

    grantee.funds_claimed = true;
    grantee.status = GranteeStatus::Funded;
    campaign.disbursed_amount = campaign.disbursed_amount.checked_add(payout_amount).ok_or(RumboError::MathOverflow)?;

    let clock = Clock::get()?;
    emit!(StipendDisbursedEvent {
        campaign: campaign.key(),
        scholar: grantee.scholar,
        amount: payout_amount,
        timestamp: clock.unix_timestamp,
    });

    msg!("Stipend successfully disbursed: {} base units to {}", payout_amount, grantee.scholar);
    Ok(())
}