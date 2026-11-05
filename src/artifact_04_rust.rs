use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("Rumb0BrkP2o26Voyag3rProtoco1111111111111111");

pub const VAULT_SEED: &[u8] = b"grant_vault";
pub const APPLICATION_SEED: &[u8] = b"builder_app";
pub const POOL_SEED: &[u8] = b"travel_pool";

#[program]
pub mod rumbo_breakpoint {
    use super::*;

    /// Initialize a Breakpoint 2026 Travel Grant Pool
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        pool_id: u64,
        total_ticket_allocation: u32,
        grant_per_winner: u64,
        timelock_deadline: i64,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        require!(grant_per_winner > 0, BreakpointError::InvalidAmount);
        require!(
            timelock_deadline > Clock::get()?.unix_timestamp,
            BreakpointError::InvalidDeadline
        );

        pool.authority = ctx.accounts.authority.key();
        pool.mint = ctx.accounts.mint.key();
        pool.pool_id = pool_id;
        pool.total_ticket_allocation = total_ticket_allocation;
        pool.remaining_tickets = total_ticket_allocation;
        pool.grant_per_winner = grant_per_winner;
        pool.timelock_deadline = timelock_deadline;
        pool.vault_bump = ctx.bumps.vault;
        pool.pool_bump = ctx.bumps.pool;
        pool.total_funded = 0;
        pool.total_disbursed = 0;

        emit!(PoolCreatedEvent {
            pool_id,
            authority: pool.authority,
            total_tickets: total_ticket_allocation,
            grant_per_winner,
            timelock_deadline,
        });

        Ok(())
    }

    /// Sponsor deposits reward funding (e.g. USDC) into the PDA vault
    pub fn deposit_pool_funds(ctx: Context<DepositPoolFunds>, amount: u64) -> Result<()> {
        require!(amount > 0, BreakpointError::InvalidAmount);

        let cpi_accounts = Transfer {
            from: ctx.accounts.funder_token_account.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.funder.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        let pool = &mut ctx.accounts.pool;
        pool.total_funded = pool
            .total_funded
            .checked_add(amount)
            .ok_or(BreakpointError::MathOverflow)?;

        emit!(PoolFundedEvent {
            pool_id: pool.pool_id,
            funder: ctx.accounts.funder.key(),
            amount,
            total_funded: pool.total_funded,
        });

        Ok(())
    }

    /// Builder submits their application to participate in the Breakpoint race
    pub fn submit_application(
        ctx: Context<SubmitApplication>,
        github_handle: [u8; 32],
        project_commit_hash: [u8; 32],
    ) -> Result<()> {
        let app = &mut ctx.accounts.application;
        let pool = &ctx.accounts.pool;
        require!(
            Clock::get()?.unix_timestamp < pool.timelock_deadline,
            BreakpointError::PoolExpired
        );

        app.builder = ctx.accounts.builder.key();
        app.pool = pool.key();
        app.github_handle = github_handle;
        app.latest_commit = project_commit_hash;
        app.milestones_completed = 0;
        app.milestones_total = 3; // 1: Prototype, 2: Testnet Deployment, 3: Production Showcase
        app.status = ApplicationStatus::UnderReview;
        app.ticket_awarded = false;
        app.amount_received = 0;
        app.bump = ctx.bumps.application;

        emit!(ApplicationSubmittedEvent {
            pool_id: pool.pool_id,
            builder: app.builder,
            github_handle,
            commit_hash: project_commit_hash,
        });

        Ok(())
    }

    /// Review council or automated verifier marks milestone progress
    pub fn evaluate_milestone(
        ctx: Context<EvaluateMilestone>,
        milestone_index: u8,
        approved: bool,
        proof_uri_hash: [u8; 32],
    ) -> Result<()> {
        let app = &mut ctx.accounts.application;
        require!(
            app.status != ApplicationStatus::Rejected && app.status != ApplicationStatus::Completed,
            BreakpointError::InvalidApplicationState
        );
        require!(
            milestone_index == app.milestones_completed + 1,
            BreakpointError::InvalidMilestoneSequence
        );

        if approved {
            app.milestones_completed = milestone_index;
            if app.milestones_completed == app.milestones_total {
                app.status = ApplicationStatus::Approved;
            }
        } else {
            app.status = ApplicationStatus::Rejected;
        }

        emit!(MilestoneEvaluatedEvent {
            builder: app.builder,
            pool: app.pool,
            milestone_index,
            approved,
            proof_uri_hash,
        });

        Ok(())
    }

    /// Disburse travel grant slice and issue Breakpoint ticket pass
    pub fn disburse_grant_and_ticket(ctx: Context<DisburseGrantAndTicket>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let app = &mut ctx.accounts.application;

        require!(
            app.status == ApplicationStatus::Approved,
            BreakpointError::ApplicationNotApproved
        );
        require!(
            !app.ticket_awarded,
            BreakpointError::TicketAlreadyAwarded
        );
        require!(
            pool.remaining_tickets > 0,
            BreakpointError::NoTicketsRemaining
        );

        let payout_amount = pool.grant_per_winner;
        require!(
            ctx.accounts.vault.amount >= payout_amount,
            BreakpointError::InsufficientPoolLiquidity
        );

        let pool_id_bytes = pool.pool_id.to_le_bytes();
        let seeds: &[&[&[u8]]] = &[&[
            VAULT_SEED,
            pool_id_bytes.as_ref(),
            &[pool.vault_bump],
        ]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.builder_token_account.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            seeds,
        );
        token::transfer(cpi_ctx, payout_amount)?;

        // Deduct remaining allocation & update state
        pool.remaining_tickets = pool
            .remaining_tickets
            .checked_sub(1)
            .ok_or(BreakpointError::MathOverflow)?;
        pool.total_disbursed = pool
            .total_disbursed
            .checked_add(payout_amount)
            .ok_or(BreakpointError::MathOverflow)?;

        app.ticket_awarded = true;
        app.status = ApplicationStatus::Completed;
        app.amount_received = payout_amount;

        emit!(WinnerAwardedEvent {
            pool_id: pool.pool_id,
            builder: app.builder,
            grant_amount: payout_amount,
            tickets_left: pool.remaining_tickets,
        });

        Ok(())
    }

    /// Timelock Clawback: If deadline passes, sponsor recovers leftover funds
    pub fn emergency_timelock_clawback(ctx: Context<ClawbackFunds>) -> Result<()> {
        let pool = &ctx.accounts.pool;
        require!(
            Clock::get()?.unix_timestamp >= pool.timelock_deadline,
            BreakpointError::TimelockActive
        );

        let remaining_balance = ctx.accounts.vault.amount;
        require!(remaining_balance > 0, BreakpointError::EmptyVault);

        let pool_id_bytes = pool.pool_id.to_le_bytes();
        let seeds: &[&[&[u8]]] = &[&[
            VAULT_SEED,
            pool_id_bytes.as_ref(),
            &[pool.vault_bump],
        ]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.authority_token_account.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            seeds,
        );
        token::transfer(cpi_ctx, remaining_balance)?;

        emit!(ClawbackExecutedEvent {
            pool_id: pool.pool_id,
            authority: pool.authority,
            amount_recovered: remaining_balance,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(pool_id: u64)]
pub struct InitializePool<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + GrantPool::INIT_SPACE,
        seeds = [POOL_SEED, pool_id.to_le_bytes().as_ref()],
        bump
    )]
    pub pool: Account<'info, GrantPool>,

    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        seeds = [VAULT_SEED, pool_id.to_le_bytes().as_ref()],
        bump,
        token::mint = mint,
        token::authority = vault
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct DepositPoolFunds<'info> {
    #[account(
        mut,
        has_one = authority @ BreakpointError::Unauthorized,
        has_one = vault @ BreakpointError::InvalidVaultAddress
    )]
    pub pool: Account<'info, GrantPool>,

    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = funder_token_account.mint == pool.mint @ BreakpointError::InvalidTokenMint
    )]
    pub funder_token_account: Account<'info, TokenAccount>,

    pub funder: Signer<'info>,
    pub authority: SystemAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SubmitApplication<'info> {
    #[account(
        init,
        payer = builder,
        space = 8 + BuilderApplication::INIT_SPACE,
        seeds = [APPLICATION_SEED, pool.key().as_ref(), builder.key().as_ref()],
        bump
    )]
    pub application: Account<'info, BuilderApplication>,

    pub pool: Account<'info, GrantPool>,

    #[account(mut)]
    pub builder: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct EvaluateMilestone<'info> {
    #[account(
        mut,
        has_one = authority @ BreakpointError::Unauthorized
    )]
    pub pool: Account<'info, GrantPool>,

    #[account(
        mut,
        has_one = pool @ BreakpointError::InvalidPoolAssociation
    )]
    pub application: Account<'info, BuilderApplication>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct DisburseGrantAndTicket<'info> {
    #[account(
        mut,
        has_one = authority @ BreakpointError::Unauthorized,
        has_one = vault @ BreakpointError::InvalidVaultAddress
    )]
    pub pool: Account<'info, GrantPool>,

    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        has_one = pool @ BreakpointError::InvalidPoolAssociation,
        has_one = builder @ BreakpointError::InvalidBuilderAddress
    )]
    pub application: Account<'info, BuilderApplication>,

    /// CHECK: Target builder receiving funds
    pub builder: SystemAccount<'info>,

    #[account(
        mut,
        constraint = builder_token_account.owner == builder.key() @ BreakpointError::InvalidAccountOwner,
        constraint = builder_token_account.mint == pool.mint @ BreakpointError::InvalidTokenMint
    )]
    pub builder_token_account: Account<'info, TokenAccount>,

    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClawbackFunds<'info> {
    #[account(
        mut,
        has_one = authority @ BreakpointError::Unauthorized,
        has_one = vault @ BreakpointError::InvalidVaultAddress
    )]
    pub pool: Account<'info, GrantPool>,

    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = authority_token_account.owner == authority.key() @ BreakpointError::InvalidAccountOwner,
        constraint = authority_token_account.mint == pool.mint @ BreakpointError::InvalidTokenMint
    )]
    pub authority_token_account: Account<'info, TokenAccount>,

    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// STATE DEFINITIONS
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct GrantPool {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub pool_id: u64,
    pub total_ticket_allocation: u32,
    pub remaining_tickets: u32,
    pub grant_per_winner: u64,
    pub total_funded: u64,
    pub total_disbursed: u64,
    pub timelock_deadline: i64,
    pub vault_bump: u8,
    pub pool_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum ApplicationStatus {
    UnderReview,
    Approved,
    Rejected,
    Completed,
}

#[account]
#[derive(InitSpace)]
pub struct BuilderApplication {
    pub builder: Pubkey,
    pub pool: Pubkey,
    pub github_handle: [u8; 32],
    pub latest_commit: [u8; 32],
    pub milestones_completed: u8,
    pub milestones_total: u8,
    pub status: ApplicationStatus,
    pub ticket_awarded: bool,
    pub amount_received: u64,
    pub bump: u8,
}

// -----------------------------------------------------------------------------
// EVENTS
// -----------------------------------------------------------------------------

#[event]
pub struct PoolCreatedEvent {
    pub pool_id: u64,
    pub authority: Pubkey,
    pub total_tickets: u32,
    pub grant_per_winner: u64,
    pub timelock_deadline: i64,
}

#[event]
pub struct PoolFundedEvent {
    pub pool_id: u64,
    pub funder: Pubkey,
    pub amount: u64,
    pub total_funded: u64,
}

#[event]
pub struct ApplicationSubmittedEvent {
    pub pool_id: u64,
    pub builder: Pubkey,
    pub github_handle: [u8; 32],
    pub commit_hash: [u8; 32],
}

#[event]
pub struct MilestoneEvaluatedEvent {
    pub builder: Pubkey,
    pub pool: Pubkey,
    pub milestone_index: u8,
    pub approved: bool,
    pub proof_uri_hash: [u8; 32],
}

#[event]
pub struct WinnerAwardedEvent {
    pub pool_id: u64,
    pub builder: Pubkey,
    pub grant_amount: u64,
    pub tickets_left: u32,
}

#[event]
pub struct ClawbackExecutedEvent {
    pub pool_id: u64,
    pub authority: Pubkey,
    pub amount_recovered: u64,
}

// -----------------------------------------------------------------------------
// ERROR CODES
// -----------------------------------------------------------------------------

#[error_code]
pub enum BreakpointError {
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Timelock deadline must be in the future")]
    InvalidDeadline,
    #[msg("Access unauthorized for caller")]
    Unauthorized,
    #[msg("Invalid vault PDA derivation")]
    InvalidVaultAddress,
    #[msg("Invalid token mint account")]
    InvalidTokenMint,
    #[msg("Grant pool deadline has already passed")]
    PoolExpired,
    #[msg("Application is not in a valid state for this action")]
    InvalidApplicationState,
    #[msg("Milestone sequence must be sequential")]
    InvalidMilestoneSequence,
    #[msg("Application has not passed all review milestones")]
    ApplicationNotApproved,
    #[msg("Breakpoint ticket already claimed by this builder")]
    TicketAlreadyAwarded,
    #[msg("All Breakpoint tickets for this pool have been allocated")]
    NoTicketsRemaining,
    #[msg("Insufficient token balance in escrow vault")]
    InsufficientPoolLiquidity,
    #[msg("Account owner mismatch")]
    InvalidAccountOwner,
    #[msg("Pool does not match application record")]
    InvalidPoolAssociation,
    #[msg("Builder pubkey mismatch")]
    InvalidBuilderAddress,
    #[msg("Timelock is still active, funds cannot be clawed back yet")]
    TimelockActive,
    #[msg("Vault has zero balance to withdraw")]
    EmptyVault,
    #[msg("Mathematical overflow encountered")]
    MathOverflow,
}