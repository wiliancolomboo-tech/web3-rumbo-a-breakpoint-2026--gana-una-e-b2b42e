use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

declare_id!("Rumb011111111111111111111111111111111111111");

#[program]
pub mod rumbo_escrow {
    use super::*;

    /// Initialize the global configuration and jury threshold parameters.
    pub fn initialize(
        ctx: Context<Initialize>,
        jury_quorum_threshold: u8,
        program_fee_basis_points: u16,
    ) -> Result<()> {
        require!(jury_quorum_threshold > 0, RumboError::InvalidQuorumThreshold);
        require!(program_fee_basis_points <= 500, RumboError::FeeExceedsCap); // Max 5%

        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.jury_quorum_threshold = jury_quorum_threshold;
        config.program_fee_basis_points = program_fee_basis_points;
        config.total_grants_created = 0;
        config.bump = ctx.bumps.config;

        emit!(ConfigInitialized {
            authority: config.authority,
            jury_quorum_threshold,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Register a developer grant with milestone-based disbursement limits.
    pub fn create_grant(
        ctx: Context<CreateGrant>,
        grant_id: u64,
        total_amount: u64,
        milestone_amounts: Vec<u64>,
        expiry_timestamp: i64,
    ) -> Result<()> {
        require!(total_amount > 0, RumboError::ZeroGrantAmount);
        require!(milestone_amounts.len() == 3, RumboError::InvalidMilestoneCount);
        
        let sum_milestones: u64 = milestone_amounts.iter().sum();
        require!(sum_milestones == total_amount, RumboError::MilestoneSumMismatch);

        let clock = Clock::get()?;
        require!(expiry_timestamp > clock.unix_timestamp, RumboError::InvalidExpiry);

        let grant = &mut ctx.accounts.grant_escrow;
        grant.grant_id = grant_id;
        grant.builder = ctx.accounts.builder.key();
        grant.sponsor = ctx.accounts.sponsor.key();
        grant.total_amount = total_amount;
        grant.disbursed_amount = 0;
        grant.milestone_amounts = [milestone_amounts[0], milestone_amounts[1], milestone_amounts[2]];
        grant.milestone_status = [MilestoneStatus::Pending; 3];
        grant.milestone_proof_hashes = [[0u8; 32]; 3];
        grant.jury_approvals = [0u8; 3];
        grant.status = GrantStatus::AwaitingFunding;
        grant.expiry_timestamp = expiry_timestamp;
        grant.bump = ctx.bumps.grant_escrow;
        grant.vault_bump = ctx.bumps.vault;

        let config = &mut ctx.accounts.config;
        config.total_grants_created = config.total_grants_created.checked_add(1).unwrap();

        emit!(GrantCreated {
            grant_id,
            builder: grant.builder,
            sponsor: grant.sponsor,
            total_amount,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Sponsor deposits native SOL into the PDA vault.
    pub fn fund_grant(ctx: Context<FundGrant>, grant_id: u64) -> Result<()> {
        let grant = &mut ctx.accounts.grant_escrow;
        require!(grant.status == GrantStatus::AwaitingFunding, RumboError::InvalidGrantState);
        require!(ctx.accounts.sponsor.key() == grant.sponsor, RumboError::Unauthorized);

        let fund_amount = grant.total_amount;

        // Perform CPI transfer of SOL to PDA vault
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.sponsor.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        );
        transfer(cpi_context, fund_amount)?;

        grant.status = GrantStatus::Active;

        emit!(GrantFunded {
            grant_id,
            sponsor: grant.sponsor,
            amount: fund_amount,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Builder submits verification evidence (e.g., flight ticket hash, proof-of-attendance hash).
    pub fn submit_milestone_proof(
        ctx: Context<SubmitMilestoneProof>,
        grant_id: u64,
        milestone_index: u8,
        proof_hash: [u8; 32],
    ) -> Result<()> {
        let index = milestone_index as usize;
        require!(index < 3, RumboError::IndexOutOfBounds);

        let grant = &mut ctx.accounts.grant_escrow;
        require!(grant.status == GrantStatus::Active, RumboError::InvalidGrantState);
        require!(ctx.accounts.builder.key() == grant.builder, RumboError::Unauthorized);
        require!(
            grant.milestone_status[index] == MilestoneStatus::Pending,
            RumboError::MilestoneAlreadySubmitted
        );

        if index > 0 {
            require!(
                grant.milestone_status[index - 1] == MilestoneStatus::Disbursed,
                RumboError::PreviousMilestoneIncomplete
            );
        }

        grant.milestone_status[index] = MilestoneStatus::Submitted;
        grant.milestone_proof_hashes[index] = proof_hash;

        emit!(MilestoneSubmitted {
            grant_id,
            milestone_index,
            proof_hash,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Evaluator / Jury member votes to accept or reject milestone proof.
    pub fn cast_jury_vote(
        ctx: Context<CastJuryVote>,
        grant_id: u64,
        milestone_index: u8,
        approve: bool,
    ) -> Result<()> {
        let index = milestone_index as usize;
        require!(index < 3, RumboError::IndexOutOfBounds);

        let grant = &mut ctx.accounts.grant_escrow;
        require!(grant.status == GrantStatus::Active, RumboError::InvalidGrantState);
        require!(
            grant.milestone_status[index] == MilestoneStatus::Submitted,
            RumboError::MilestoneNotSubmitted
        );

        let vote_record = &mut ctx.accounts.vote_record;
        require!(!vote_record.has_voted, RumboError::AlreadyVoted);

        vote_record.grant_id = grant_id;
        vote_record.milestone_index = milestone_index;
        vote_record.juror = ctx.accounts.juror.key();
        vote_record.approved = approve;
        vote_record.has_voted = true;
        vote_record.bump = ctx.bumps.vote_record;

        if approve {
            grant.jury_approvals[index] = grant.jury_approvals[index].checked_add(1).unwrap();
        }

        emit!(JuryVoteCast {
            grant_id,
            milestone_index,
            juror: ctx.accounts.juror.key(),
            approved: approve,
            current_approvals: grant.jury_approvals[index],
        });

        Ok(())
    }

    /// Disburse funds to the builder once milestone reaches jury quorum.
    pub fn disburse_milestone(
        ctx: Context<DisburseMilestone>,
        grant_id: u64,
        milestone_index: u8,
    ) -> Result<()> {
        let index = milestone_index as usize;
        require!(index < 3, RumboError::IndexOutOfBounds);

        let config = &ctx.accounts.config;
        let grant = &mut ctx.accounts.grant_escrow;

        require!(grant.status == GrantStatus::Active, RumboError::InvalidGrantState);
        require!(
            grant.milestone_status[index] == MilestoneStatus::Submitted,
            RumboError::MilestoneNotSubmitted
        );
        require!(
            grant.jury_approvals[index] >= config.jury_quorum_threshold,
            RumboError::InsufficientJuryQuorum
        );

        let amount_to_disburse = grant.milestone_amounts[index];
        require!(
            ctx.accounts.vault.to_account_info().lamports() >= amount_to_disburse,
            RumboError::InsufficientVaultBalance
        );

        // Disburse lamports from vault PDA to builder
        let grant_key = grant.key();
        let seeds = &[
            b"vault",
            grant_key.as_ref(),
            &[grant.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.builder.to_account_info(),
            },
            signer_seeds,
        );
        transfer(transfer_ctx, amount_to_disburse)?;

        grant.disbursed_amount = grant.disbursed_amount.checked_add(amount_to_disburse).unwrap();
        grant.milestone_status[index] = MilestoneStatus::Disbursed;

        if index == 2 {
            grant.status = GrantStatus::Completed;
        }

        emit!(MilestoneDisbursed {
            grant_id,
            milestone_index,
            builder: grant.builder,
            amount: amount_to_disburse,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Clawback remaining unreleased funds back to sponsor after grant expiration.
    pub fn emergency_refund_expired(ctx: Context<EmergencyRefund>, grant_id: u64) -> Result<()> {
        let grant = &mut ctx.accounts.grant_escrow;
        let clock = Clock::get()?;

        require!(
            clock.unix_timestamp > grant.expiry_timestamp,
            RumboError::GrantNotExpired
        );
        require!(
            grant.status == GrantStatus::Active || grant.status == GrantStatus::AwaitingFunding,
            RumboError::GrantCannotBeRefunded
        );

        let vault_balance = ctx.accounts.vault.to_account_info().lamports();
        if vault_balance > 0 {
            let grant_key = grant.key();
            let seeds = &[
                b"vault",
                grant_key.as_ref(),
                &[grant.vault_bump],
            ];
            let signer_seeds = &[&seeds[..]];

            let transfer_ctx = CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.sponsor.to_account_info(),
                },
                signer_seeds,
            );
            transfer(transfer_ctx, vault_balance)?;
        }

        grant.status = GrantStatus::Cancelled;

        emit!(GrantRefunded {
            grant_id,
            sponsor: grant.sponsor,
            refunded_amount: vault_balance,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub fn initialize_instruction(ctx: &Context<Initialize>) -> Result<()> {
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Config::LEN,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(grant_id: u64)]
pub struct CreateGrant<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = sponsor,
        space = 8 + GrantEscrow::LEN,
        seeds = [b"grant", builder.key().as_ref(), &grant_id.to_le_bytes()],
        bump
    )]
    pub grant_escrow: Account<'info, GrantEscrow>,
    /// CHECK: Safe PDA acting as the lamport vault.
    #[account(
        mut,
        seeds = [b"vault", grant_escrow.key().as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,
    /// CHECK: Checked against instruction signature.
    pub builder: AccountInfo<'info>,
    #[account(mut)]
    pub sponsor: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(grant_id: u64)]
pub struct FundGrant<'info> {
    #[account(
        mut,
        seeds = [b"grant", grant_escrow.builder.as_ref(), &grant_id.to_le_bytes()],
        bump = grant_escrow.bump
    )]
    pub grant_escrow: Account<'info, GrantEscrow>,
    /// CHECK: Safe PDA acting as the lamport vault.
    #[account(
        mut,
        seeds = [b"vault", grant_escrow.key().as_ref()],
        bump = grant_escrow.vault_bump
    )]
    pub vault: SystemAccount<'info>,
    #[account(mut)]
    pub sponsor: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(grant_id: u64, milestone_index: u8)]
pub struct SubmitMilestoneProof<'info> {
    #[account(
        mut,
        seeds = [b"grant", builder.key().as_ref(), &grant_id.to_le_bytes()],
        bump = grant_escrow.bump
    )]
    pub grant_escrow: Account<'info, GrantEscrow>,
    pub builder: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(grant_id: u64, milestone_index: u8)]
pub struct CastJuryVote<'info> {
    #[account(
        mut,
        seeds = [b"grant", grant_escrow.builder.as_ref(), &grant_id.to_le_bytes()],
        bump = grant_escrow.bump
    )]
    pub grant_escrow: Account<'info, GrantEscrow>,
    #[account(
        init,
        payer = juror,
        space = 8 + VoteRecord::LEN,
        seeds = [b"vote", grant_escrow.key().as_ref(), &[milestone_index], juror.key().as_ref()],
        bump
    )]
    pub vote_record: Account<'info, VoteRecord>,
    #[account(mut)]
    pub juror: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(grant_id: u64, milestone_index: u8)]
pub struct DisburseMilestone<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"grant", grant_escrow.builder.as_ref(), &grant_id.to_le_bytes()],
        bump = grant_escrow.bump
    )]
    pub grant_escrow: Account<'info, GrantEscrow>,
    /// CHECK: Safe PDA lamport vault
    #[account(
        mut,
        seeds = [b"vault", grant_escrow.key().as_ref()],
        bump = grant_escrow.vault_bump
    )]
    pub vault: SystemAccount<'info>,
    /// CHECK: Must match the builder address in grant_escrow
    #[account(
        mut,
        address = grant_escrow.builder @ RumboError::InvalidRecipient
    )]
    pub builder: AccountInfo<'info>,
    pub caller: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(grant_id: u64)]
pub struct EmergencyRefund<'info> {
    #[account(
        mut,
        seeds = [b"grant", grant_escrow.builder.as_ref(), &grant_id.to_le_bytes()],
        bump = grant_escrow.bump
    )]
    pub grant_escrow: Account<'info, GrantEscrow>,
    /// CHECK: Safe PDA lamport vault
    #[account(
        mut,
        seeds = [b"vault", grant_escrow.key().as_ref()],
        bump = grant_escrow.vault_bump
    )]
    pub vault: SystemAccount<'info>,
    /// CHECK: Must match sponsor saved in grant_escrow
    #[account(
        mut,
        address = grant_escrow.sponsor @ RumboError::InvalidSponsor
    )]
    pub sponsor: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

// -----------------------------------------------------------------------------
// STATE MODELS
// -----------------------------------------------------------------------------

#[account]
pub struct Config {
    pub authority: Pubkey,
    pub jury_quorum_threshold: u8,
    pub program_fee_basis_points: u16,
    pub total_grants_created: u64,
    pub bump: u8,
}

impl Config {
    pub const LEN: usize = 32 + 1 + 2 + 8 + 1;
}

#[account]
pub struct GrantEscrow {
    pub grant_id: u64,
    pub builder: Pubkey,
    pub sponsor: Pubkey,
    pub total_amount: u64,
    pub disbursed_amount: u64,
    pub milestone_amounts: [u64; 3],
    pub milestone_status: [MilestoneStatus; 3],
    pub milestone_proof_hashes: [[u8; 32]; 3],
    pub jury_approvals: [u8; 3],
    pub status: GrantStatus,
    pub expiry_timestamp: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

impl GrantEscrow {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 8 + (8 * 3) + (1 * 3) + (32 * 3) + (1 * 3) + 1 + 8 + 1 + 1;
}

#[account]
pub struct VoteRecord {
    pub grant_id: u64,
    pub milestone_index: u8,
    pub juror: Pubkey,
    pub approved: bool,
    pub has_voted: bool,
    pub bump: u8,
}

impl VoteRecord {
    pub const LEN: usize = 8 + 1 + 32 + 1 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum GrantStatus {
    AwaitingFunding,
    Active,
    Completed,
    Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum MilestoneStatus {
    Pending,
    Submitted,
    Disbursed,
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct ConfigInitialized {
    pub authority: Pubkey,
    pub jury_quorum_threshold: u8,
    pub timestamp: i64,
}

#[event]
pub struct GrantCreated {
    pub grant_id: u64,
    pub builder: Pubkey,
    pub sponsor: Pubkey,
    pub total_amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct GrantFunded {
    pub grant_id: u64,
    pub sponsor: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct MilestoneSubmitted {
    pub grant_id: u64,
    pub milestone_index: u8,
    pub proof_hash: [u8; 32],
    pub timestamp: i64,
}

#[event]
pub struct JuryVoteCast {
    pub grant_id: u64,
    pub milestone_index: u8,
    pub juror: Pubkey,
    pub approved: bool,
    pub current_approvals: u8,
}

#[event]
pub struct MilestoneDisbursed {
    pub grant_id: u64,
    pub milestone_index: u8,
    pub builder: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct GrantRefunded {
    pub grant_id: u64,
    pub sponsor: Pubkey,
    pub refunded_amount: u64,
    pub timestamp: i64,
}

#[error_code]
pub enum RumboError {
    #[msg("Quorum threshold must be greater than zero.")]
    InvalidQuorumThreshold,
    #[msg("Protocol fee exceeds hard cap of 500 bps.")]
    FeeExceedsCap,
    #[msg("Grant amount must be greater than zero.")]
    ZeroGrantAmount,
    #[msg("Grant must specify exactly 3 milestone amounts.")]
    InvalidMilestoneCount,
    #[msg("Sum of milestones does not match total grant amount.")]
    MilestoneSumMismatch,
    #[msg("Expiry timestamp must be in the future.")]
    InvalidExpiry,
    #[msg("Invalid grant status for this operation.")]
    InvalidGrantState,
    #[msg("Unauthorized signer for this grant operation.")]
    Unauthorized,
    #[msg("Index out of bounds for milestones.")]
    IndexOutOfBounds,
    #[msg("Milestone proof has already been submitted.")]
    MilestoneAlreadySubmitted,
    #[msg("Previous milestone has not been disbursed yet.")]
    PreviousMilestoneIncomplete,
    #[msg("Milestone has not yet been submitted by the builder.")]
    MilestoneNotSubmitted,
    #[msg("Juror has already cast a vote for this milestone.")]
    AlreadyVoted,
    #[msg("Milestone has not reached jury threshold quorum.")]
    InsufficientJuryQuorum,
    #[msg("Insufficient balance in vault PDA.")]
    InsufficientVaultBalance,
    #[msg("Supplied recipient does not match builder in grant state.")]
    InvalidRecipient,
    #[msg("Supplied refund destination does not match sponsor.")]
    InvalidSponsor,
    #[msg("Grant has not yet expired.")]
    GrantNotExpired,
    #[msg("Grant status is not eligible for refund.")]
    GrantCannotBeRefunded,
}