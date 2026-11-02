use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use crate::state::Campaign;
use crate::errors::RumboError;

#[derive(Accounts)]
#[instruction(title: String)]
pub struct InitializeCampaign<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        space = 8 + Campaign::INIT_SPACE,
        seeds = [b"campaign", authority.key().as_ref(), title.as_bytes()],
        bump
    )]
    pub campaign: Account<'info, Campaign>,

    #[account(
        init,
        payer = authority,
        seeds = [b"vault", campaign.key().as_ref()],
        bump,
        token::mint = token_mint,
        token::authority = vault
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = sponsor_token_account.mint == token_mint.key(),
        constraint = sponsor_token_account.owner == authority.key()
    )]
    pub sponsor_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<InitializeCampaign>,
    title: String,
    total_allocation: u64,
    stipend_per_scholar: u64,
    duration_seconds: i64,
) -> Result<()> {
    require!(title.len() <= 64, RumboError::InputStringTooLong);
    let clock = Clock::get()?;

    let campaign = &mut ctx.accounts.campaign;
    campaign.authority = ctx.accounts.authority.key();
    campaign.token_mint = ctx.accounts.token_mint.key();
    campaign.vault = ctx.accounts.vault.key();
    campaign.total_allocation = total_allocation;
    campaign.disbursed_amount = 0;
    campaign.stipend_per_scholar = stipend_per_scholar;
    campaign.total_grantees = 0;
    campaign.approved_grantees = 0;
    campaign.deadline = clock.unix_timestamp.checked_add(duration_seconds).ok_or(RumboError::MathOverflow)?;
    campaign.bump = ctx.bumps.campaign;
    campaign.vault_bump = ctx.bumps.vault;
    campaign.title = title;

    // Deposit funding into PDA vault
    let transfer_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.sponsor_token_account.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        },
    );
    token::transfer(transfer_ctx, total_allocation)?;

    msg!("Campaign initialized successfully: {}", campaign.title);
    Ok(())
}