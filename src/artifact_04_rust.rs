use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

declare_id!("RumbogK9aM8aXG9HNx5mZ3KkH9u4kR3A1b8ZpS7v2vE");

pub const MAX_NAME_LEN: usize = 64;
pub const MAX_EMAIL_LEN: usize = 128;
pub const MAX_MILESTONES: usize = 3;

#[program]
pub mod rumbo_protocol {
    use super::*;

    /// Initializes a new travel grant pool for Breakpoint 2026.
    pub fn initialize_grant_pool(
        ctx: Context<InitializeGrantPool>,
        pool_name: String,
        total_stipend_per_builder: u64,
        max_builders: u32,
        claim_deadline: i64,
    ) -> Result<()> {
        require!(
            pool_name.as_bytes().len() <= MAX_NAME_LEN,
            RumboError::StringExceedsLimit
        );
        require!(
            total_stipend_per_builder > 0,
            RumboError::InvalidStipendAmount
        );
        require!(
            claim_deadline > Clock::get()?.unix_timestamp,
            RumboError::InvalidDeadline
        );

        let pool = &mut ctx.accounts.grant_pool;
        pool.authority = ctx.accounts.authority.key();
        pool.pool_name = pool_name;
        pool.total_stipend_per_builder = total_stipend_per_builder;
        pool.max_builders = max_builders;
        pool.registered_builders = 0;
        pool.disbursed_funds = 0;
        pool.claim_deadline = claim_deadline;
        pool.bump = ctx.bumps.grant_pool;
        pool.vault_bump = ctx.bumps.vault;

        emit!(GrantPoolInitializedEvent {
            pool: pool.key(),
            authority: pool.authority,
            total_stipend_per_builder,
            max_builders,
            claim_deadline,
        });

        Ok(())
    }

    /// Builder applies for a Breakpoint travel grant.
    pub fn apply_for_grant(
        ctx: Context<ApplyForGrant>,
        builder_name: String,
        contact_email: String,
    ) -> Result<()> {
        require!(
            builder_name.as_bytes().len() <= MAX_NAME_LEN,
            RumboError::StringExceedsLimit
        );
        require!(
            contact_email.as_bytes().len() <= MAX_EMAIL_LEN,
            RumboError::StringExceedsLimit
        );

        let pool = &mut ctx.accounts.grant_pool;
        require!(
            pool.registered_builders < pool.max_builders,
            RumboError::PoolCapacityReached
        );
        require!(
            Clock::get()?.unix_timestamp < pool.claim_deadline,
            RumboError::DeadlineExceeded
        );

        let application = &mut ctx.accounts.application;
        application.pool = pool.key();
        application.builder = ctx.accounts.builder.key();
        application.builder_name = builder_name.clone();
        application.contact_email = contact_email.clone();
        application.status = ApplicationStatus::Submitted;
        application.milestone_progress = 0;
        application.funds_claimed = 0;
        application.ticket_issued = false;
        application.bump = ctx.bumps.application;

        // Initialize 3 default Breakpoint milestones:
        // 0: Flight/Visa verification (30%)
        // 1: Technical Build Submission (40%)
        // 2: Event Check-in & Demo (30%)
        application.milestones = [
            Milestone {
                weight_bps: 3000,
                approved: false,
                paid: false,
                proof_hash: [0u8; 32],
            },
            Milestone {
                weight_bps: 4000,
                approved: false,
                paid: false,
                proof_hash: [0u8; 32],
            },
            Milestone {
                weight_bps: 3000,
                approved: false,
                paid: false,
                proof_hash: [0u8; 32],
            },
        ];

        pool.registered_builders = pool.registered_builders.checked_add(1).ok_or(RumboError::MathOverflow)?;

        emit!(ApplicationSubmittedEvent {
            pool: pool.key(),
            builder: application.builder,
            name: builder_name,
            email: contact_email,
        });

        Ok(())
    }

    /// Committee evaluates a specific milestone for an applicant.
    pub fn evaluate_milestone(
        ctx: Context<EvaluateMilestone>,
        milestone_index: u8,
        approved: bool,
        proof_hash: [u8; 32],
    ) -> Result<()> {
        let index = milestone_index as usize;
        require!(index < MAX_MILESTONES, RumboError::InvalidMilestoneIndex);

        let application = &mut ctx.accounts.application;
        let milestone = &mut application.milestones[index];

        require!(!milestone.approved, RumboError::MilestoneAlreadyApproved);

        milestone.approved = approved;
        milestone.proof_hash = proof_hash;

        if approved {
            application.milestone_progress = application
                .milestone_progress
                .checked_add(1)
                .ok_or(RumboError::MathOverflow)?;

            if application.status == ApplicationStatus::Submitted {
                application.status = ApplicationStatus::Active;
            }
        }

        emit!(MilestoneEvaluatedEvent {
            application: application.key(),
            builder: application.builder,
            milestone_index,
            approved,
            proof_hash,
        });

        Ok(())
    }

    /// Disburse funds for an approved milestone from the vault directly to the builder.
    pub fn release_milestone_funds(
        ctx: Context<ReleaseMilestoneFunds>,
        milestone_index: u8,
    ) -> Result<()> {
        let index = milestone_index as usize;
        require!(index < MAX_MILESTONES, RumboError::InvalidMilestoneIndex);

        let pool = &ctx.accounts.grant_pool;
        let application = &mut ctx.accounts.application;
        let milestone = &mut application.milestones[index];

        require!(milestone.approved, RumboError::MilestoneNotApproved);
        require!(!milestone.paid, RumboError::MilestoneAlreadyPaid);

        // Compute tranche disbursement: (Total * weight_bps) / 10000
        let tranche_amount = (pool.total_stipend_per_builder as u128)
            .checked_mul(milestone.weight_bps as u128)
            .ok_or(RumboError::MathOverflow)?
            .checked_div(10000)
            .ok_or(RumboError::MathOverflow)? as u64;

        let vault_balance = ctx.accounts.vault.to_account_info().lamports();
        require!(vault_balance >= tranche_amount, RumboError::InsufficientVaultFunds);

        milestone.paid = true;
        application.funds_claimed = application
            .funds_claimed
            .checked_add(tranche_amount)
            .ok_or(RumboError::MathOverflow)?;

        // Transfer funds from PDA vault to builder
        let pool_key = pool.key();
        let seeds = &[
            b"vault",
            pool_key.as_ref(),
            &[pool.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_context = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.builder.to_account_info(),
            },
            signer_seeds,
        );
        transfer(cpi_context, tranche_amount)?;

        emit!(MilestonePaidEvent {
            application: application.key(),
            builder: application.builder,
            milestone_index,
            amount_disbursed: tranche_amount,
        });

        Ok(())
    }

    /// Issues an on-chain non-transferable attendee travel ticket pass credential.
    pub fn issue_ticket_credential(ctx: Context<IssueTicketCredential>) -> Result<()> {
        let application = &mut ctx.accounts.application;
        require!(
            application.milestone_progress >= 1,
            RumboError::InsufficientMilestonesForTicket
        );
        require!(!application.ticket_issued, RumboError::TicketAlreadyIssued);

        let ticket = &mut ctx.accounts.ticket_pass;
        ticket.pool = ctx.accounts.grant_pool.key();
        ticket.builder = application.builder;
        ticket.issued_at = Clock::get()?.unix_timestamp;
        ticket.ticket_id = format!("BP2026-{}", &application.builder.to_string()[..8]);
        ticket.bump = ctx.bumps.ticket_pass;

        application.ticket_issued = true;

        emit!(TicketCredentialIssuedEvent {
            pool: ticket.pool,
            builder: ticket.builder,
            ticket_id: ticket.ticket_id.clone(),
            issued_at: ticket.issued_at,
        });

        Ok(())
    }

    /// Emergency clawback for unused funds after the Breakpoint claim deadline.
    pub fn clawback_unclaimed(ctx: Context<ClawbackUnclaimed>) -> Result<()> {
        let pool = &ctx.accounts.grant_pool;
        require!(
            Clock::get()?.unix_timestamp > pool.claim_deadline,
            RumboError::ClawbackLocked
        );

        let remaining_lamports = ctx.accounts.vault.to_account_info().lamports();
        require!(remaining_lamports > 0, RumboError::NoFundsAvailable);

        let pool_key = pool.key();
        let seeds = &[
            b"vault",
            pool_key.as_ref(),
            &[pool.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_context = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.authority.to_account_info(),
            },
            signer_seeds,
        );
        transfer(cpi_context, remaining_lamports)?;

        emit!(ClawbackExecutedEvent {
            pool: pool.key(),
            amount: remaining_lamports,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// INSTRUCTION ACCOUNTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(pool_name: String)]
pub struct InitializeGrantPool<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + GrantPool::INIT_SPACE,
        seeds = [b"grant_pool", authority.key().as_ref(), pool_name.as_bytes()],
        bump
    )]
    pub grant_pool: Account<'info, GrantPool>,

    /// CHECK: PDA treasury vault holding grant lamports
    #[account(
        mut,
        seeds = [b"vault", grant_pool.key().as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ApplyForGrant<'info> {
    #[account(mut)]
    pub grant_pool: Account<'info, GrantPool>,

    #[account(
        init,
        payer = builder,
        space = 8 + BuilderApplication::INIT_SPACE,
        seeds = [b"application", grant_pool.key().as_ref(), builder.key().as_ref()],
        bump
    )]
    pub application: Account<'info, BuilderApplication>,

    #[account(mut)]
    pub builder: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct EvaluateMilestone<'info> {
    #[account(
        has_one = authority @ RumboError::UnauthorizedCommittee
    )]
    pub grant_pool: Account<'info, GrantPool>,

    #[account(
        mut,
        has_one = pool @ RumboError::InvalidApplicationPoolRelation
    )]
    pub application: Account<'info, BuilderApplication>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ReleaseMilestoneFunds<'info> {
    #[account(
        mut,
        has_one = authority @ RumboError::UnauthorizedCommittee
    )]
    pub grant_pool: Account<'info, GrantPool>,

    #[account(
        mut,
        seeds = [b"vault", grant_pool.key().as_ref()],
        bump = grant_pool.vault_bump
    )]
    pub vault: SystemAccount<'info>,

    #[account(
        mut,
        has_one = pool @ RumboError::InvalidApplicationPoolRelation
    )]
    pub application: Account<'info, BuilderApplication>,

    /// CHECK: Must match the builder stored in the application account
    #[account(
        mut,
        address = application.builder @ RumboError::UnauthorizedBuilder
    )]
    pub builder: SystemAccount<'info>,

    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct IssueTicketCredential<'info> {
    pub grant_pool: Account<'info, GrantPool>,

    #[account(
        mut,
        has_one = pool @ RumboError::InvalidApplicationPoolRelation,
        has_one = builder @ RumboError::UnauthorizedBuilder
    )]
    pub application: Account<'info, BuilderApplication>,

    #[account(
        init,
        payer = builder,
        space = 8 + TicketPass::INIT_SPACE,
        seeds = [b"ticket", grant_pool.key().as_ref(), builder.key().as_ref()],
        bump
    )]
    pub ticket_pass: Account<'info, TicketPass>,

    #[account(mut)]
    pub builder: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClawbackUnclaimed<'info> {
    #[account(
        mut,
        has_one = authority @ RumboError::UnauthorizedCommittee
    )]
    pub grant_pool: Account<'info, GrantPool>,

    #[account(
        mut,
        seeds = [b"vault", grant_pool.key().as_ref()],
        bump = grant_pool.vault_bump
    )]
    pub vault: SystemAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// -----------------------------------------------------------------------------
// STATE STRUCTS
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct GrantPool {
    pub authority: Pubkey,
    #[max_len(64)]
    pub pool_name: String,
    pub total_stipend_per_builder: u64,
    pub max_builders: u32,
    pub registered_builders: u32,
    pub disbursed_funds: u64,
    pub claim_deadline: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum ApplicationStatus {
    Submitted,
    Active,
    Completed,
    Rejected,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace)]
pub struct Milestone {
    pub weight_bps: u16,
    pub approved: bool,
    pub paid: bool,
    pub proof_hash: [u8; 32],
}

#[account]
#[derive(InitSpace)]
pub struct BuilderApplication {
    pub pool: Pubkey,
    pub builder: Pubkey,
    #[max_len(64)]
    pub builder_name: String,
    #[max_len(128)]
    pub contact_email: String,
    pub status: ApplicationStatus,
    pub milestone_progress: u8,
    pub funds_claimed: u64,
    pub ticket_issued: bool,
    pub bump: u8,
    pub milestones: [Milestone; 3],
}

#[account]
#[derive(InitSpace)]
pub struct TicketPass {
    pub pool: Pubkey,
    pub builder: Pubkey,
    pub issued_at: i64,
    #[max_len(32)]
    pub ticket_id: String,
    pub bump: u8,
}

// -----------------------------------------------------------------------------
// EVENTS
// -----------------------------------------------------------------------------

#[event]
pub struct GrantPoolInitializedEvent {
    pub pool: Pubkey,
    pub authority: Pubkey,
    pub total_stipend_per_builder: u64,
    pub max_builders: u32,
    pub claim_deadline: i64,
}

#[event]
pub struct ApplicationSubmittedEvent {
    pub pool: Pubkey,
    pub builder: Pubkey,
    pub name: String,
    pub email: String,
}

#[event]
pub struct MilestoneEvaluatedEvent {
    pub application: Pubkey,
    pub builder: Pubkey,
    pub milestone_index: u8,
    pub approved: bool,
    pub proof_hash: [u8; 32],
}

#[event]
pub struct MilestonePaidEvent {
    pub application: Pubkey,
    pub builder: Pubkey,
    pub milestone_index: u8,
    pub amount_disbursed: u64,
}

#[event]
pub struct TicketCredentialIssuedEvent {
    pub pool: Pubkey,
    pub builder: Pubkey,
    pub ticket_id: String,
    pub issued_at: i64,
}

#[event]
pub struct ClawbackExecutedEvent {
    pub pool: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

// -----------------------------------------------------------------------------
// ERROR CODES
// -----------------------------------------------------------------------------

#[error_code]
pub enum RumboError {
    #[msg("String exceeds maximum allowable byte length")]
    StringExceedsLimit,
    #[msg("Stipend amount must be greater than zero")]
    InvalidStipendAmount,
    #[msg("Claim deadline must be set in the future")]
    InvalidDeadline,
    #[msg("Grant pool has reached full capacity")]
    PoolCapacityReached,
    #[msg("Milestone application deadline has expired")]
    DeadlineExceeded,
    #[msg("Invalid milestone index requested")]
    InvalidMilestoneIndex,
    #[msg("Milestone has already been reviewed and approved")]
    MilestoneAlreadyApproved,
    #[msg("Milestone has not yet been approved by the committee")]
    MilestoneNotApproved,
    #[msg("Milestone funds have already been claimed and disbursed")]
    MilestoneAlreadyPaid,
    #[msg("Insufficient lamports available inside the PDA vault")]
    InsufficientVaultFunds,
    #[msg("Builder must complete at least 1 milestone to unlock ticket credential")]
    InsufficientMilestonesForTicket,
    #[msg("Ticket credential has already been minted for this builder")]
    TicketAlreadyIssued,
    #[msg("Grant pool deadline has not yet elapsed for clawback")]
    ClawbackLocked,
    #[msg("No funds available in vault to clawback")]
    NoFundsAvailable,
    #[msg("Unauthorized: Caller is not the registered grant authority")]
    UnauthorizedCommittee,
    #[msg("Unauthorized: Signer does not match the application builder")]
    UnauthorizedBuilder,
    #[msg("Application does not belong to the supplied grant pool")]
    InvalidApplicationPoolRelation,
    #[msg("Arithmetic overflow detected in state transition")]
    MathOverflow,
}