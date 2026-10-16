use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("RumbopasS1111111111111111111111111111111111");

#[program]
pub mod rumbo_passage {
    use super::*;

    /// Initializes a global Sponsorship Campaign for Breakpoint 2026.
    pub fn initialize_campaign(
        ctx: Context<InitializeCampaign>,
        campaign_id: String,
        clawback_deadline: i64,
    ) -> Result<()> {
        require!(campaign_id.len() <= 32, RumboError::StringTooLong);
        let clock = Clock::get()?;
        require!(
            clawback_deadline > clock.unix_timestamp,
            RumboError::InvalidDeadline
        );

        let campaign = &mut ctx.accounts.campaign;
        campaign.authority = ctx.accounts.authority.key();
        campaign.vault_mint = ctx.accounts.vault_mint.key();
        campaign.campaign_id = campaign_id;
        campaign.clawback_deadline = clawback_deadline;
        campaign.total_allocated = 0;
        campaign.total_disbursed = 0;
        campaign.grantee_count = 0;
        campaign.bump = ctx.bumps.campaign;

        emit!(CampaignInitialized {
            campaign: campaign.key(),
            authority: campaign.authority,
            clawback_deadline,
        });

        Ok(())
    }

    /// Allocates a new Grant Escrow for a designated builder/grantee.
    pub fn create_grant(
        ctx: Context<CreateGrant>,
        total_stipend: u64,
        milestone_splits: [u8; 3], // Percentage distribution e.g., [40, 40, 20]
    ) -> Result<()> {
        require!(total_stipend > 0, RumboError::InvalidStipendAmount);
        let sum_split: u8 = milestone_splits.iter().sum();
        require!(sum_split == 100, RumboError::InvalidMilestoneSplits);

        let campaign = &mut ctx.accounts.campaign;
        let grant = &mut ctx.accounts.grant;

        grant.campaign = campaign.key();
        grant.grantee = ctx.accounts.grantee.key();
        grant.total_amount = total_stipend;
        grant.amount_released = 0;
        grant.milestone_splits = milestone_splits;
        grant.current_milestone = 0; // 0 = Flight/Lodging, 1 = Hackathon/Badge, 2 = Showcase
        grant.status = GrantStatus::Active;
        grant.bump = ctx.bumps.grant;
        grant.vault_bump = ctx.bumps.grant_vault;

        campaign.total_allocated = campaign
            .total_allocated
            .checked_add(total_stipend)
            .ok_or(RumboError::MathOverflow)?;
        campaign.grantee_count = campaign
            .grantee_count
            .checked_add(1)
            .ok_or(RumboError::MathOverflow)?;

        // Transfer funds from Sponsor funding account to Grant PDA Token Vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.sponsor_token_account.to_account_info(),
            to: ctx.accounts.grant_vault.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, total_stipend)?;

        emit!(GrantCreated {
            campaign: campaign.key(),
            grant: grant.key(),
            grantee: grant.grantee,
            amount: total_stipend,
        });

        Ok(())
    }

    /// Grantee submits milestone proof (e.g. Flight booking PNR hash, Breakpoint badge ID, GitHub PR).
    pub fn submit_milestone(
        ctx: Context<SubmitMilestone>,
        milestone_index: u8,
        proof_uri: String,
    ) -> Result<()> {
        let grant = &mut ctx.accounts.grant;
        require!(grant.status == GrantStatus::Active, RumboError::GrantNotActive);
        require!(milestone_index == grant.current_milestone, RumboError::InvalidMilestoneSequence);
        require!(milestone_index < 3, RumboError::InvalidMilestoneIndex);
        require!(proof_uri.len() <= 128, RumboError::StringTooLong);

        let milestone = &mut ctx.accounts.milestone_record;
        milestone.grant = grant.key();
        milestone.milestone_index = milestone_index;
        milestone.proof_uri = proof_uri.clone();
        milestone.status = MilestoneStatus::Submitted;
        milestone.submitted_at = Clock::get()?.unix_timestamp;
        milestone.bump = ctx.bumps.milestone_record;

        emit!(MilestoneSubmitted {
            grant: grant.key(),
            grantee: grant.grantee,
            milestone_index,
            proof_uri,
        });

        Ok(())
    }

    /// Sponsor authority reviews and approves milestone, disbursing the tranche to the grantee.
    pub fn approve_milestone_and_disburse(
        ctx: Context<ApproveMilestoneAndDisburse>,
        milestone_index: u8,
    ) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        let grant = &mut ctx.accounts.grant;
        let milestone = &mut ctx.accounts.milestone_record;

        require!(grant.status == GrantStatus::Active, RumboError::GrantNotActive);
        require!(milestone.status == MilestoneStatus::Submitted, RumboError::MilestoneNotSubmitted);
        require!(milestone.milestone_index == milestone_index, RumboError::InvalidMilestoneIndex);
        require!(grant.current_milestone == milestone_index, RumboError::InvalidMilestoneSequence);

        let percentage = grant.milestone_splits[milestone_index as usize] as u64;
        let tranche_amount = grant
            .total_amount
            .checked_mul(percentage)
            .ok_or(RumboError::MathOverflow)?
            .checked_div(100)
            .ok_or(RumboError::MathOverflow)?;

        // Ensure we do not disburse more than remaining vault balance
        let remaining = grant.total_amount.checked_sub(grant.amount_released).ok_or(RumboError::MathOverflow)?;
        let payout = tranche_amount.min(remaining);

        // Sign transfer using Grant PDA seeds
        let grant_key = grant.key();
        let seeds = &[
            b"grant-vault",
            grant_key.as_ref(),
            &[grant.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.grant_vault.to_account_info(),
            to: ctx.accounts.grantee_token_account.to_account_info(),
            authority: ctx.accounts.grant_vault.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);
        token::transfer(cpi_ctx, payout)?;

        grant.amount_released = grant
            .amount_released
            .checked_add(payout)
            .ok_or(RumboError::MathOverflow)?;
        grant.current_milestone = grant
            .current_milestone
            .checked_add(1)
            .ok_or(RumboError::MathOverflow)?;

        if grant.current_milestone >= 3 || grant.amount_released >= grant.total_amount {
            grant.status = GrantStatus::Completed;
        }

        milestone.status = MilestoneStatus::Approved;
        campaign.total_disbursed = campaign
            .total_disbursed
            .checked_add(payout)
            .ok_or(RumboError::MathOverflow)?;

        emit!(MilestoneApprovedAndDisbursed {
            grant: grant.key(),
            grantee: grant.grantee,
            milestone_index,
            amount_disbursed: payout,
        });

        Ok(())
    }

    /// Sponsor emergency clawback if builder goes unresponsive or milestone deadline expires.
    pub fn clawback_unclaimed_funds(ctx: Context<ClawbackFunds>) -> Result<()> {
        let clock = Clock::get()?;
        let campaign = &ctx.accounts.campaign;
        let grant = &mut ctx.accounts.grant;

        require!(
            clock.unix_timestamp >= campaign.clawback_deadline,
            RumboError::ClawbackDeadlineNotMet
        );
        require!(grant.status == GrantStatus::Active, RumboError::GrantAlreadyClosed);

        let unreleased_funds = grant
            .total_amount
            .checked_sub(grant.amount_released)
            .ok_or(RumboError::MathOverflow)?;

        require!(unreleased_funds > 0, RumboError::NoFundsRemaining);

        let grant_key = grant.key();
        let seeds = &[
            b"grant-vault",
            grant_key.as_ref(),
            &[grant.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.grant_vault.to_account_info(),
            to: ctx.accounts.sponsor_token_account.to_account_info(),
            authority: ctx.accounts.grant_vault.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);
        token::transfer(cpi_ctx, unreleased_funds)?;

        grant.status = GrantStatus::ClawedBack;

        emit!(GrantClawedBack {
            grant: grant.key(),
            amount_refunded: unreleased_funds,
            recipient: ctx.accounts.sponsor_token_account.key(),
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(campaign_id: String)]
pub struct InitializeCampaign<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + CampaignConfig::INIT_SPACE,
        seeds = [b"campaign", authority.key().as_ref(), campaign_id.as_bytes()],
        bump
    )]
    pub campaign: Account<'info, CampaignConfig>,
    pub vault_mint: Account<'info, Mint>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateGrant<'info> {
    #[account(
        mut,
        has_one = authority @ RumboError::Unauthorized,
        has_one = vault_mint @ RumboError::MismatchedMint
    )]
    pub campaign: Account<'info, CampaignConfig>,
    pub vault_mint: Account<'info, Mint>,
    /// CHECK: Grantee wallet receiving the travel stipends
    pub grantee: AccountInfo<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + GrantEscrow::INIT_SPACE,
        seeds = [b"grant", campaign.key().as_ref(), grantee.key().as_ref()],
        bump
    )]
    pub grant: Account<'info, GrantEscrow>,

    #[account(
        init,
        payer = authority,
        seeds = [b"grant-vault", grant.key().as_ref()],
        bump,
        token::mint = vault_mint,
        token::authority = grant_vault
    )]
    pub grant_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = sponsor_token_account.mint == vault_mint.key() @ RumboError::MismatchedMint,
        constraint = sponsor_token_account.owner == authority.key() @ RumboError::Unauthorized
    )]
    pub sponsor_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(milestone_index: u8)]
pub struct SubmitMilestone<'info> {
    #[account(
        mut,
        has_one = grantee @ RumboError::Unauthorized
    )]
    pub grant: Account<'info, GrantEscrow>,

    #[account(
        init_if_needed,
        payer = grantee,
        space = 8 + MilestoneRecord::INIT_SPACE,
        seeds = [b"milestone", grant.key().as_ref(), &[milestone_index]],
        bump
    )]
    pub milestone_record: Account<'info, MilestoneRecord>,

    #[account(mut)]
    pub grantee: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(milestone_index: u8)]
pub struct ApproveMilestoneAndDisburse<'info> {
    #[account(
        mut,
        has_one = authority @ RumboError::Unauthorized,
        has_one = vault_mint @ RumboError::MismatchedMint
    )]
    pub campaign: Account<'info, CampaignConfig>,
    pub vault_mint: Account<'info, Mint>,

    #[account(
        mut,
        has_one = campaign @ RumboError::MismatchedCampaign
    )]
    pub grant: Account<'info, GrantEscrow>,

    #[account(
        mut,
        seeds = [b"milestone", grant.key().as_ref(), &[milestone_index]],
        bump = milestone_record.bump
    )]
    pub milestone_record: Account<'info, MilestoneRecord>,

    #[account(
        mut,
        seeds = [b"grant-vault", grant.key().as_ref()],
        bump = grant.vault_bump
    )]
    pub grant_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = grantee_token_account.owner == grant.grantee @ RumboError::MismatchedGrantee,
        constraint = grantee_token_account.mint == vault_mint.key() @ RumboError::MismatchedMint
    )]
    pub grantee_token_account: Account<'info, TokenAccount>,

    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClawbackFunds<'info> {
    #[account(
        mut,
        has_one = authority @ RumboError::Unauthorized,
        has_one = vault_mint @ RumboError::MismatchedMint
    )]
    pub campaign: Account<'info, CampaignConfig>,
    pub vault_mint: Account<'info, Mint>,

    #[account(
        mut,
        has_one = campaign @ RumboError::MismatchedCampaign
    )]
    pub grant: Account<'info, GrantEscrow>,

    #[account(
        mut,
        seeds = [b"grant-vault", grant.key().as_ref()],
        bump = grant.vault_bump
    )]
    pub grant_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = sponsor_token_account.owner == authority.key() @ RumboError::Unauthorized,
        constraint = sponsor_token_account.mint == vault_mint.key() @ RumboError::MismatchedMint
    )]
    pub sponsor_token_account: Account<'info, TokenAccount>,

    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// STATE STRUCTS & ENUMS
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct CampaignConfig {
    pub authority: Pubkey,
    pub vault_mint: Pubkey,
    #[max_len(32)]
    pub campaign_id: String,
    pub clawback_deadline: i64,
    pub total_allocated: u64,
    pub total_disbursed: u64,
    pub grantee_count: u32,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct GrantEscrow {
    pub campaign: Pubkey,
    pub grantee: Pubkey,
    pub total_amount: u64,
    pub amount_released: u64,
    pub milestone_splits: [u8; 3],
    pub current_milestone: u8,
    pub status: GrantStatus,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct MilestoneRecord {
    pub grant: Pubkey,
    pub milestone_index: u8,
    #[max_len(128)]
    pub proof_uri: String,
    pub status: MilestoneStatus,
    pub submitted_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum GrantStatus {
    Active,
    Completed,
    ClawedBack,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum MilestoneStatus {
    Pending,
    Submitted,
    Approved,
    Rejected,
}

// -----------------------------------------------------------------------------
// EVENTS
// -----------------------------------------------------------------------------

#[event]
pub struct CampaignInitialized {
    pub campaign: Pubkey,
    pub authority: Pubkey,
    pub clawback_deadline: i64,
}

#[event]
pub struct GrantCreated {
    pub campaign: Pubkey,
    pub grant: Pubkey,
    pub grantee: Pubkey,
    pub amount: u64,
}

#[event]
pub struct MilestoneSubmitted {
    pub grant: Pubkey,
    pub grantee: Pubkey,
    pub milestone_index: u8,
    pub proof_uri: String,
}

#[event]
pub struct MilestoneApprovedAndDisbursed {
    pub grant: Pubkey,
    pub grantee: Pubkey,
    pub milestone_index: u8,
    pub amount_disbursed: u64,
}

#[event]
pub struct GrantClawedBack {
    pub grant: Pubkey,
    pub amount_refunded: u64,
    pub recipient: Pubkey,
}

// -----------------------------------------------------------------------------
// ERROR CODES
// -----------------------------------------------------------------------------

#[error_code]
pub enum RumboError {
    #[msg("String exceeds maximum allowable length")]
    StringTooLong,
    #[msg("Deadline must be positioned in the future")]
    InvalidDeadline,
    #[msg("Stipend amount must be greater than zero")]
    InvalidStipendAmount,
    #[msg("Milestone splits array must sum precisely to 100%")]
    InvalidMilestoneSplits,
    #[msg("Arithmetic overflow detected in calculation")]
    MathOverflow,
    #[msg("Signer does not possess required authority")]
    Unauthorized,
    #[msg("Supplied token mint does not match configuration")]
    MismatchedMint,
    #[msg("Grant account is currently not in Active status")]
    GrantNotActive,
    #[msg("Milestones must be completed in sequential order")]
    InvalidMilestoneSequence,
    #[msg("Invalid milestone index specified")]
    InvalidMilestoneIndex,
    #[msg("Milestone has not yet been submitted for review")]
    MilestoneNotSubmitted,
    #[msg("Supplied campaign does not match the record on the grant")]
    MismatchedCampaign,
    #[msg("Token account does not belong to authorized grantee")]
    MismatchedGrantee,
    #[msg("Clawback window is not yet unlocked")]
    ClawbackDeadlineNotMet,
    #[msg("Grant has already been finalized or closed")]
    GrantAlreadyClosed,
    #[msg("No remaining unreleased funds left in escrow")]
    NoFundsRemaining,
}