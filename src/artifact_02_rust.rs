use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

declare_id!("RumbobXjA5Fw5yHhBqHk1Y1L2mC8oY3P4r8q6g3tB2n");

#[program]
pub mod rumbo_breakpoint {
    use super::*;

    /// Initialize the Rumbo Breakpoint configuration and sponsor vault
    pub fn initialize_program(
        ctx: Context<InitializeProgram>,
        max_grant_amount: u64,
        total_seats: u32,
    ) -> Result<()> {
        require!(max_grant_amount > 0, RumboError::InvalidGrantAmount);
        require!(total_seats > 0, RumboError::InvalidSeatCount);

        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.vault_bump = ctx.bumps.vault;
        config.config_bump = ctx.bumps.config;
        config.max_grant_amount = max_grant_amount;
        config.total_seats = total_seats;
        config.allocated_seats = 0;
        config.total_disbursed = 0;
        config.is_paused = false;

        emit!(ConfigInitializedEvent {
            admin: config.admin,
            max_grant_amount,
            total_seats,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Builder submits a grant application for travel support and a Breakpoint ticket
    pub fn apply_for_grant(
        ctx: Context<ApplyForGrant>,
        github_handle: String,
        metadata_uri_hash: [u8; 32],
        requested_amount: u64,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.is_paused, RumboError::ProgramPaused);
        require!(
            github_handle.len() > 0 && github_handle.len() <= 64,
            RumboError::InvalidGithubHandle
        );
        require!(
            requested_amount > 0 && requested_amount <= config.max_grant_amount,
            RumboError::GrantAmountExceeded
        );

        let grant = &mut ctx.accounts.grant;
        grant.applicant = ctx.accounts.applicant.key();
        grant.bump = ctx.bumps.grant;
        grant.github_handle = github_handle.clone();
        grant.metadata_uri_hash = metadata_uri_hash;
        grant.requested_amount = requested_amount;
        grant.disbursed_amount = 0;
        grant.status = GrantStatus::Pending;
        grant.milestone_level = 0;
        grant.created_at = Clock::get()?.unix_timestamp;

        emit!(GrantAppliedEvent {
            applicant: grant.applicant,
            github_handle,
            requested_amount,
            metadata_uri_hash,
            timestamp: grant.created_at,
        });

        Ok(())
    }

    /// Admin / Committee reviews the application (Approve, Reject, or Revoke)
    pub fn review_application(
        ctx: Context<ReviewApplication>,
        new_status: GrantStatus,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let grant = &mut ctx.accounts.grant;

        require!(grant.status == GrantStatus::Pending, RumboError::InvalidStatusTransition);
        require!(
            new_status == GrantStatus::Approved || new_status == GrantStatus::Rejected,
            RumboError::InvalidStatusTransition
        );

        if new_status == GrantStatus::Approved {
            require!(
                config.allocated_seats < config.total_seats,
                RumboError::NoSeatsAvailable
            );
            config.allocated_seats = config.allocated_seats.checked_add(1).ok_or(RumboError::MathOverflow)?;
        }

        grant.status = new_status;

        emit!(GrantReviewedEvent {
            applicant: grant.applicant,
            status: grant.status,
            reviewer: ctx.accounts.admin.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Verify a project milestone and disburse funds directly from the Vault PDA
    pub fn verify_milestone_and_disburse(
        ctx: Context<VerifyMilestoneAndDisburse>,
        disbursement_amount: u64,
        proof_hash: [u8; 32],
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let grant = &mut ctx.accounts.grant;

        require!(!config.is_paused, RumboError::ProgramPaused);
        require!(grant.status == GrantStatus::Approved, RumboError::GrantNotApproved);
        require!(disbursement_amount > 0, RumboError::InvalidDisbursementAmount);

        let potential_total = grant
            .disbursed_amount
            .checked_add(disbursement_amount)
            .ok_or(RumboError::MathOverflow)?;

        require!(
            potential_total <= grant.requested_amount,
            RumboError::DisbursementCapExceeded
        );

        let vault_lamports = ctx.accounts.vault.to_account_info().lamports();
        require!(
            vault_lamports >= disbursement_amount,
            RumboError::InsufficientVaultFunds
        );

        // Deduct from vault PDA using CPI with seeds
        let admin_key = config.admin;
        let seeds = &[
            b"vault".as_ref(),
            admin_key.as_ref(),
            &[config.vault_bump],
        ];
        let signer = &[&seeds[..]];

        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.applicant.to_account_info(),
            },
            signer,
        );

        transfer(transfer_ctx, disbursement_amount)?;

        // Update state
        grant.disbursed_amount = potential_total;
        grant.milestone_level = grant.milestone_level.checked_add(1).ok_or(RumboError::MathOverflow)?;
        
        if grant.disbursed_amount == grant.requested_amount {
            grant.status = GrantStatus::Completed;
        }

        config.total_disbursed = config
            .total_disbursed
            .checked_add(disbursement_amount)
            .ok_or(RumboError::MathOverflow)?;

        emit!(MilestoneDisbursedEvent {
            applicant: grant.applicant,
            amount: disbursement_amount,
            milestone_level: grant.milestone_level,
            proof_hash,
            total_disbursed_to_applicant: grant.disbursed_amount,
            status: grant.status,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Admin can deposit native lamports to the escrow vault
    pub fn fund_vault(ctx: Context<FundVault>, amount: u64) -> Result<()> {
        require!(amount > 0, RumboError::InvalidDepositAmount);

        let transfer_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.admin.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        );
        transfer(transfer_ctx, amount)?;

        emit!(VaultFundedEvent {
            funder: ctx.accounts.admin.key(),
            amount,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Admin emergency pause toggle
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.is_paused = paused;
        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub fn initialize_program_accounts(
    admin: &Signer,
) -> bool {
    true
}

#[derive(Accounts)]
pub struct InitializeProgram<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + ConfigAccount::LEN,
        seeds = [b"config", admin.key().as_ref()],
        bump
    )]
    pub config: Account<'info, ConfigAccount>,

    /// CHECK: PDA acting as the fund vault; safe because seeds and bump are validated
    #[account(
        mut,
        seeds = [b"vault", admin.key().as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ApplyForGrant<'info> {
    #[account(
        init,
        payer = applicant,
        space = 8 + GrantAccount::LEN,
        seeds = [b"grant", applicant.key().as_ref()],
        bump
    )]
    pub grant: Account<'info, GrantAccount>,

    #[account(
        seeds = [b"config", config.admin.as_ref()],
        bump = config.config_bump
    )]
    pub config: Account<'info, ConfigAccount>,

    #[account(mut)]
    pub applicant: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReviewApplication<'info> {
    #[account(
        mut,
        seeds = [b"config", config.admin.as_ref()],
        bump = config.config_bump,
        has_one = admin @ RumboError::UnauthorizedAdmin
    )]
    pub config: Account<'info, ConfigAccount>,

    #[account(
        mut,
        seeds = [b"grant", grant.applicant.as_ref()],
        bump = grant.bump
    )]
    pub grant: Account<'info, GrantAccount>,

    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct VerifyMilestoneAndDisburse<'info> {
    #[account(
        mut,
        seeds = [b"config", config.admin.as_ref()],
        bump = config.config_bump,
        has_one = admin @ RumboError::UnauthorizedAdmin
    )]
    pub config: Account<'info, ConfigAccount>,

    #[account(
        mut,
        seeds = [b"grant", applicant.key().as_ref()],
        bump = grant.bump,
        has_one = applicant @ RumboError::ApplicantMismatch
    )]
    pub grant: Account<'info, GrantAccount>,

    /// CHECK: PDA holds travel funds; checked via seeds
    #[account(
        mut,
        seeds = [b"vault", config.admin.as_ref()],
        bump = config.vault_bump
    )]
    pub vault: SystemAccount<'info>,

    /// CHECK: Target recipient account, verified by grant.applicant
    #[account(mut)]
    pub applicant: SystemAccount<'info>,

    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundVault<'info> {
    #[account(
        seeds = [b"config", config.admin.as_ref()],
        bump = config.config_bump,
        has_one = admin @ RumboError::UnauthorizedAdmin
    )]
    pub config: Account<'info, ConfigAccount>,

    /// CHECK: PDA fund vault
    #[account(
        mut,
        seeds = [b"vault", config.admin.as_ref()],
        bump = config.vault_bump
    )]
    pub vault: SystemAccount<'info>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(
        mut,
        seeds = [b"config", config.admin.as_ref()],
        bump = config.config_bump,
        has_one = admin @ RumboError::UnauthorizedAdmin
    )]
    pub config: Account<'info, ConfigAccount>,

    pub admin: Signer<'info>,
}

// -----------------------------------------------------------------------------
// STATE DEFINITIONS
// -----------------------------------------------------------------------------

#[account]
pub struct ConfigAccount {
    pub admin: Pubkey,         // 32
    pub vault_bump: u8,        // 1
    pub config_bump: u8,       // 1
    pub max_grant_amount: u64, // 8
    pub total_seats: u32,      // 4
    pub allocated_seats: u32,  // 4
    pub total_disbursed: u64,  // 8
    pub is_paused: bool,       // 1
}

impl ConfigAccount {
    pub const LEN: usize = 32 + 1 + 1 + 8 + 4 + 4 + 8 + 1 + 32; // padded
}

#[account]
pub struct GrantAccount {
    pub applicant: Pubkey,            // 32
    pub bump: u8,                     // 1
    pub github_handle: String,        // 4 + 64 = 68
    pub metadata_uri_hash: [u8; 32],  // 32
    pub requested_amount: u64,        // 8
    pub disbursed_amount: u64,        // 8
    pub status: GrantStatus,          // 1
    pub milestone_level: u8,          // 1
    pub created_at: i64,              // 8
}

impl GrantAccount {
    pub const LEN: usize = 32 + 1 + 68 + 32 + 8 + 8 + 1 + 1 + 8 + 32;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum GrantStatus {
    Pending,
    Approved,
    Rejected,
    Completed,
}

// -----------------------------------------------------------------------------
// EVENTS
// -----------------------------------------------------------------------------

#[event]
pub struct ConfigInitializedEvent {
    pub admin: Pubkey,
    pub max_grant_amount: u64,
    pub total_seats: u32,
    pub timestamp: i64,
}

#[event]
pub struct GrantAppliedEvent {
    pub applicant: Pubkey,
    pub github_handle: String,
    pub requested_amount: u64,
    pub metadata_uri_hash: [u8; 32],
    pub timestamp: i64,
}

#[event]
pub struct GrantReviewedEvent {
    pub applicant: Pubkey,
    pub status: GrantStatus,
    pub reviewer: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct MilestoneDisbursedEvent {
    pub applicant: Pubkey,
    pub amount: u64,
    pub milestone_level: u8,
    pub proof_hash: [u8; 32],
    pub total_disbursed_to_applicant: u64,
    pub status: GrantStatus,
    pub timestamp: i64,
}

#[event]
pub struct VaultFundedEvent {
    pub funder: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

// -----------------------------------------------------------------------------
// ERROR CODES
// -----------------------------------------------------------------------------

#[error_code]
pub enum RumboError {
    #[msg("Grant amount must be greater than zero.")]
    InvalidGrantAmount,
    #[msg("Total travel seats must be greater than zero.")]
    InvalidSeatCount,
    #[msg("Program operations are currently paused by the admin.")]
    ProgramPaused,
    #[msg("Github handle must be non-empty and max 64 characters.")]
    InvalidGithubHandle,
    #[msg("Requested grant amount exceeds program maximum limit.")]
    GrantAmountExceeded,
    #[msg("Invalid status transition for grant.")]
    InvalidStatusTransition,
    #[msg("All allocated Breakpoint seats have been exhausted.")]
    NoSeatsAvailable,
    #[msg("Arithmetic overflow detected.")]
    MathOverflow,
    #[msg("Only approved grants can receive milestone disbursements.")]
    GrantNotApproved,
    #[msg("Disbursement amount must be greater than zero.")]
    InvalidDisbursementAmount,
    #[msg("Disbursement exceeds total requested grant allocation.")]
    DisbursementCapExceeded,
    #[msg("Insufficient lamports in the escrow vault.")]
    InsufficientVaultFunds,
    #[msg("Deposit amount must be greater than zero.")]
    InvalidDepositAmount,
    #[msg("Signer is not authorized as the program admin.")]
    UnauthorizedAdmin,
    #[msg("Applicant pubkey does not match grant profile.")]
    ApplicantMismatch,
}