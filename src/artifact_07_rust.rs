use anchor_lang::prelude::*;

pub mod errors;
pub mod state;

use errors::*;
use state::*;

declare_id!("Rumb0Brkpt202611111111111111111111111111111");

#[program]
pub mod rumbo_breakpoint {
    use super::*;

    pub fn initialize(
        ctx: Context<InitializeConfig>,
        reviewer_oracle: Pubkey,
        checkin_authority: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.reviewer_oracle = reviewer_oracle;
        config.event_checkin_authority = checkin_authority;
        config.total_allocated = 0;
        config.total_disbursed = 0;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn apply(
        ctx: Context<ApplyForGrant>,
        repo_commit_hash: [u8; 32],
        grant_amount: u64,
        deadline_timestamp: i64,
        metadata_uri: String,
    ) -> Result<()> {
        require!(
            metadata_uri.len() <= GrantApplication::MAX_METADATA_LEN,
            BreakpointError::MetadataTooLong
        );

        let grant = &mut ctx.accounts.grant;
        grant.grantee = ctx.accounts.grantee.key();
        grant.repo_commit_hash = repo_commit_hash;
        grant.grant_amount = grant_amount;
        grant.disbursed_amount = 0;
        grant.deadline_timestamp = deadline_timestamp;
        grant.stage = GrantStage::Submitted;
        grant.metadata_uri = metadata_uri;
        grant.bump = ctx.bumps.grant;
        grant.vault_bump = ctx.bumps.escrow_vault;

        emit!(ApplicationSubmittedEvent {
            grantee: grant.grantee,
            grant_amount,
            deadline: deadline_timestamp,
        });

        Ok(())
    }

    pub fn approve_and_fund(ctx: Context<ApproveAndFund>) -> Result<()> {
        let grant = &mut ctx.accounts.grant;
        let config = &mut ctx.accounts.config;

        require!(
            grant.stage == GrantStage::Submitted,
            BreakpointError::InvalidStageTransition
        );

        // Transfer funds from Admin to Escrow Vault PDA
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.admin.to_account_info(),
                to: ctx.accounts.escrow_vault.to_account_info(),
            },
        );
        anchor_lang::system_program::transfer(cpi_context, grant.grant_amount)?;

        grant.stage = GrantStage::Funded;
        config.total_allocated = config
            .total_allocated
            .checked_add(grant.grant_amount)
            .ok_or(BreakpointError::MathOverflow)?;

        emit!(GrantFundedEvent {
            grantee: grant.grantee,
            amount: grant.grant_amount,
        });

        Ok(())
    }

    pub fn verify_milestone_and_release(ctx: Context<VerifyMilestone>) -> Result<()> {
        let grant = &mut ctx.accounts.grant;
        let config = &mut ctx.accounts.config;
        let clock = Clock::get()?;

        require!(
            grant.stage == GrantStage::Funded,
            BreakpointError::InvalidStageTransition
        );
        require!(
            clock.unix_timestamp <= grant.deadline_timestamp,
            BreakpointError::GrantExpired
        );

        // Tranche 1: 50% released for flights and lodging
        let tranche_1 = grant
            .grant_amount
            .checked_div(2)
            .ok_or(BreakpointError::MathOverflow)?;

        **ctx.accounts.escrow_vault.try_borrow_mut_lamports()? = ctx
            .accounts
            .escrow_vault
            .lamports()
            .checked_sub(tranche_1)
            .ok_or(BreakpointError::MathOverflow)?;

        **ctx.accounts.grantee.try_borrow_mut_lamports()? = ctx
            .accounts
            .grantee
            .lamports()
            .checked_add(tranche_1)
            .ok_or(BreakpointError::MathOverflow)?;

        grant.disbursed_amount = tranche_1;
        grant.stage = GrantStage::MilestoneVerified;

        config.total_disbursed = config
            .total_disbursed
            .checked_add(tranche_1)
            .ok_or(BreakpointError::MathOverflow)?;

        emit!(MilestoneApprovedEvent {
            grantee: grant.grantee,
            amount_released: tranche_1,
            stage: grant.stage,
        });

        Ok(())
    }

    pub fn checkin_and_settle(ctx: Context<CheckinAndSettle>) -> Result<()> {
        let grant = &mut ctx.accounts.grant;
        let config = &mut ctx.accounts.config;

        require!(
            grant.stage == GrantStage::MilestoneVerified,
            BreakpointError::InvalidStageTransition
        );

        // Tranche 2: Remaining 50%
        let remaining_lamports = grant
            .grant_amount
            .checked_sub(grant.disbursed_amount)
            .ok_or(BreakpointError::MathOverflow)?;

        **ctx.accounts.escrow_vault.try_borrow_mut_lamports()? = ctx
            .accounts
            .escrow_vault
            .lamports()
            .checked_sub(remaining_lamports)
            .ok_or(BreakpointError::MathOverflow)?;

        **ctx.accounts.grantee.try_borrow_mut_lamports()? = ctx
            .accounts
            .grantee
            .lamports()
            .checked_add(remaining_lamports)
            .ok_or(BreakpointError::MathOverflow)?;

        grant.disbursed_amount = grant.grant_amount;
        grant.stage = GrantStage::AttendedAndSettled;

        config.total_disbursed = config
            .total_disbursed
            .checked_add(remaining_lamports)
            .ok_or(BreakpointError::MathOverflow)?;

        emit!(GrantFullySettledEvent {
            grantee: grant.grantee,
            total_disbursed: grant.disbursed_amount,
        });

        Ok(())
    }

    pub fn clawback_expired(ctx: Context<ClawbackExpired>) -> Result<()> {
        let grant = &mut ctx.accounts.grant;
        let clock = Clock::get()?;

        require!(
            grant.stage == GrantStage::Funded || grant.stage == GrantStage::MilestoneVerified,
            BreakpointError::InvalidStageTransition
        );
        require!(
            clock.unix_timestamp > grant.deadline_timestamp,
            BreakpointError::GrantNotExpired
        );

        let remaining = ctx.accounts.escrow_vault.lamports();

        **ctx.accounts.escrow_vault.try_borrow_mut_lamports()? = 0;
        **ctx.accounts.admin.try_borrow_mut_lamports()? = ctx
            .accounts
            .admin
            .lamports()
            .checked_add(remaining)
            .ok_or(BreakpointError::MathOverflow)?;

        grant.stage = GrantStage::ClawedBack;

        emit!(GrantClawedBackEvent {
            grantee: grant.grantee,
            recovered_amount: remaining,
        });

        Ok(())
    }
}

// ---------------- Contexts ----------------

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = admin,
        space = ProgramConfig::LEN,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, ProgramConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ApplyForGrant<'info> {
    #[account(
        init,
        payer = grantee,
        space = GrantApplication::LEN,
        seeds = [b"grant", grantee.key().as_ref()],
        bump
    )]
    pub grant: Account<'info, GrantApplication>,
    /// CHECK: Escrow Vault account solely derived from grantee seeds
    #[account(
        mut,
        seeds = [b"vault", grantee.key().as_ref()],
        bump
    )]
    pub escrow_vault: AccountInfo<'info>,
    #[account(mut)]
    pub grantee: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ApproveAndFund<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = admin @ BreakpointError::Unauthorized
    )]
    pub config: Account<'info, ProgramConfig>,
    #[account(
        mut,
        seeds = [b"grant", grant.grantee.as_ref()],
        bump = grant.bump
    )]
    pub grant: Account<'info, GrantApplication>,
    /// CHECK: Escrow Vault PDA verified by seeds
    #[account(
        mut,
        seeds = [b"vault", grant.grantee.as_ref()],
        bump = grant.vault_bump
    )]
    pub escrow_vault: AccountInfo<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct VerifyMilestone<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = reviewer_oracle @ BreakpointError::Unauthorized
    )]
    pub config: Account<'info, ProgramConfig>,
    #[account(
        mut,
        seeds = [b"grant", grant.grantee.as_ref()],
        bump = grant.bump
    )]
    pub grant: Account<'info, GrantApplication>,
    /// CHECK: Escrow Vault PDA verified by seeds
    #[account(
        mut,
        seeds = [b"vault", grant.grantee.as_ref()],
        bump = grant.vault_bump
    )]
    pub escrow_vault: AccountInfo<'info>,
    /// CHECK: Verified against grant.grantee
    #[account(
        mut,
        address = grant.grantee @ BreakpointError::Unauthorized
    )]
    pub grantee: AccountInfo<'info>,
    pub reviewer_oracle: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CheckinAndSettle<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = event_checkin_authority @ BreakpointError::Unauthorized
    )]
    pub config: Account<'info, ProgramConfig>,
    #[account(
        mut,
        seeds = [b"grant", grant.grantee.as_ref()],
        bump = grant.bump
    )]
    pub grant: Account<'info, GrantApplication>,
    /// CHECK: Escrow Vault PDA verified by seeds
    #[account(
        mut,
        seeds = [b"vault", grant.grantee.as_ref()],
        bump = grant.vault_bump
    )]
    pub escrow_vault: AccountInfo<'info>,
    /// CHECK: Safe destination
    #[account(
        mut,
        address = grant.grantee @ BreakpointError::Unauthorized
    )]
    pub grantee: AccountInfo<'info>,
    pub event_checkin_authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClawbackExpired<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = admin @ BreakpointError::Unauthorized
    )]
    pub config: Account<'info, ProgramConfig>,
    #[account(
        mut,
        seeds = [b"grant", grant.grantee.as_ref()],
        bump = grant.bump
    )]
    pub grant: Account<'info, GrantApplication>,
    /// CHECK: Escrow Vault PDA
    #[account(
        mut,
        seeds = [b"vault", grant.grantee.as_ref()],
        bump = grant.vault_bump
    )]
    pub escrow_vault: AccountInfo<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// ---------------- Events ----------------

#[event]
pub struct ApplicationSubmittedEvent {
    pub grantee: Pubkey,
    pub grant_amount: u64,
    pub deadline: i64,
}

#[event]
pub struct GrantFundedEvent {
    pub grantee: Pubkey,
    pub amount: u64,
}

#[event]
pub struct MilestoneApprovedEvent {
    pub grantee: Pubkey,
    pub amount_released: u64,
    pub stage: GrantStage,
}

#[event]
pub struct GrantFullySettledEvent {
    pub grantee: Pubkey,
    pub total_disbursed: u64,
}

#[event]
pub struct GrantClawedBackEvent {
    pub grantee: Pubkey,
    pub recovered_amount: u64,
}