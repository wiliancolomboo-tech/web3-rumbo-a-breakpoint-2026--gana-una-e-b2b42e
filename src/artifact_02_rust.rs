use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("RumbocFh9JvWkmFq9vY9qg8yV7qN5u8kL2vX4Xo1QWz");

pub const MAX_JURY_MEMBERS: usize = 5;
pub const MILESTONES_COUNT: usize = 3;
pub const DISBURSEMENT_PERCENTAGES: [u8; 3] = [30, 40, 30]; // 30% Ship Code, 40% Flight Booking, 30% On-site Check-in

#[program]
pub mod rumbo_protocol {
    use super::*;

    /// Initialize the global Grant Campaign (e.g. Rumbo a Breakpoint 2026)
    pub fn initialize_campaign(
        ctx: Context<InitializeCampaign>,
        quorum_required: u8,
        total_ticket_quota: u32,
        jury_members: Vec<Pubkey>,
    ) -> Result<()> {
        require!(
            jury_members.len() <= MAX_JURY_MEMBERS,
            RumboError::TooManyJuryMembers
        );
        require!(
            quorum_required as usize <= jury_members.len() && quorum_required > 0,
            RumboError::InvalidQuorum
        );

        let campaign = &mut ctx.accounts.campaign;
        campaign.admin = ctx.accounts.admin.key();
        campaign.vault_mint = ctx.accounts.vault_mint.key();
        campaign.vault = ctx.accounts.vault.key();
        campaign.quorum_required = quorum_required;
        campaign.total_ticket_quota = total_ticket_quota;
        campaign.allocated_tickets = 0;
        campaign.total_funds_allocated = 0;
        campaign.jury_members = jury_members;
        campaign.bump = ctx.bumps.campaign;
        campaign.vault_bump = ctx.bumps.vault;

        emit!(CampaignInitializedEvent {
            admin: campaign.admin,
            total_ticket_quota,
            quorum_required,
        });

        Ok(())
    }

    /// Deposit USDC / funding tokens into the Grant Escrow Vault
    pub fn fund_escrow(ctx: Context<FundEscrow>, amount: u64) -> Result<()> {
        require!(amount > 0, RumboError::InvalidAmount);

        let cpi_accounts = Transfer {
            from: ctx.accounts.funder_token_account.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.funder.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        emit!(EscrowFundedEvent {
            funder: ctx.accounts.funder.key(),
            amount,
        });

        Ok(())
    }

    /// Apply for the grant with project repository / concept SHA-256 hash
    pub fn apply_grant(
        ctx: Context<ApplyGrant>,
        stipend_requested: u64,
        application_hash: [u8; 32],
    ) -> Result<()> {
        require!(stipend_requested > 0, RumboError::InvalidAmount);

        let applicant = &mut ctx.accounts.grant_application;
        applicant.applicant = ctx.accounts.applicant.key();
        applicant.campaign = ctx.accounts.campaign.key();
        applicant.stipend_total = stipend_requested;
        applicant.stipend_claimed = 0;
        applicant.application_hash = application_hash;
        applicant.current_milestone = 0;
        applicant.ticket_awarded = false;
        applicant.bump = ctx.bumps.grant_application;

        for i in 0..MILESTONES_COUNT {
            applicant.milestones[i] = MilestoneState {
                proof_hash: [0u8; 32],
                approvals_count: 0,
                approving_jurors: [Pubkey::default(); MAX_JURY_MEMBERS],
                status: MilestoneStatus::NotStarted,
            };
        }

        emit!(ApplicationSubmittedEvent {
            applicant: applicant.applicant,
            stipend_total: stipend_requested,
            application_hash,
        });

        Ok(())
    }

    /// Submit cryptographic proof for a specific milestone (e.g. Itinerary or Code)
    pub fn submit_milestone_proof(
        ctx: Context<SubmitMilestoneProof>,
        milestone_index: u8,
        proof_hash: [u8; 32],
    ) -> Result<()> {
        let applicant = &mut ctx.accounts.grant_application;
        let idx = milestone_index as usize;

        require!(idx < MILESTONES_COUNT, RumboError::InvalidMilestoneIndex);
        require!(
            idx == applicant.current_milestone as usize,
            RumboError::MilestoneSequenceViolation
        );

        let milestone = &mut applicant.milestones[idx];
        require!(
            milestone.status == MilestoneStatus::NotStarted
                || milestone.status == MilestoneStatus::Rejected,
            RumboError::InvalidMilestoneState
        );

        milestone.proof_hash = proof_hash;
        milestone.status = MilestoneStatus::PendingReview;

        emit!(MilestoneProofSubmittedEvent {
            applicant: applicant.applicant,
            milestone_index,
            proof_hash,
        });

        Ok(())
    }

    /// Evaluator / Jury member votes on milestone completion
    pub fn vote_milestone(
        ctx: Context<VoteMilestone>,
        milestone_index: u8,
        approve: bool,
    ) -> Result<()> {
        let campaign = &ctx.accounts.campaign;
        let applicant = &mut ctx.accounts.grant_application;
        let juror = ctx.accounts.juror.key();
        let idx = milestone_index as usize;

        require!(idx < MILESTONES_COUNT, RumboError::InvalidMilestoneIndex);
        require!(
            campaign.jury_members.contains(&juror),
            RumboError::UnauthorizedJuror
        );

        let milestone = &mut applicant.milestones[idx];
        require!(
            milestone.status == MilestoneStatus::PendingReview,
            RumboError::MilestoneNotUnderReview
        );

        // Check if juror already voted
        for j in 0..milestone.approvals_count as usize {
            require!(
                milestone.approving_jurors[j] != juror,
                RumboError::DuplicateVote
            );
        }

        if approve {
            milestone.approving_jurors[milestone.approvals_count as usize] = juror;
            milestone.approvals_count += 1;

            if milestone.approvals_count >= campaign.quorum_required {
                milestone.status = MilestoneStatus::Approved;
            }
        } else {
            milestone.status = MilestoneStatus::Rejected;
        }

        emit!(MilestoneVotedEvent {
            applicant: applicant.applicant,
            juror,
            milestone_index,
            approved: approve,
            approvals_count: milestone.approvals_count,
        });

        Ok(())
    }

    /// Disburse funds to developer once milestone is approved
    pub fn disburse_milestone_funds(
        ctx: Context<DisburseMilestoneFunds>,
        milestone_index: u8,
    ) -> Result<()> {
        let applicant = &mut ctx.accounts.grant_application;
        let campaign = &mut ctx.accounts.campaign;
        let idx = milestone_index as usize;

        require!(idx < MILESTONES_COUNT, RumboError::InvalidMilestoneIndex);
        require!(
            idx == applicant.current_milestone as usize,
            RumboError::MilestoneSequenceViolation
        );

        let milestone = &mut applicant.milestones[idx];
        require!(
            milestone.status == MilestoneStatus::Approved,
            RumboError::MilestoneNotApproved
        );

        // Calculate tranche amount
        let percentage = DISBURSEMENT_PERCENTAGES[idx] as u64;
        let amount = applicant
            .stipend_total
            .checked_mul(percentage)
            .ok_or(RumboError::MathOverflow)?
            .checked_div(100)
            .ok_or(RumboError::MathOverflow)?;

        // Execute CPI transfer from PDA vault
        let admin_key = campaign.admin;
        let seeds = &[
            b"rumbo_vault".as_ref(),
            admin_key.as_ref(),
            &[campaign.vault_bump],
        ];
        let signer = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.applicant_token_account.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer,
        );
        token::transfer(cpi_ctx, amount)?;

        milestone.status = MilestoneStatus::Disbursed;
        applicant.stipend_claimed = applicant
            .stipend_claimed
            .checked_add(amount)
            .ok_or(RumboError::MathOverflow)?;
        applicant.current_milestone += 1;

        // If all 3 milestones reached, award Breakpoint entry pass
        if applicant.current_milestone == MILESTONES_COUNT as u8 {
            require!(
                campaign.allocated_tickets < campaign.total_ticket_quota,
                RumboError::TicketsExhausted
            );
            campaign.allocated_tickets += 1;
            applicant.ticket_awarded = true;
        }

        emit!(FundsDisbursedEvent {
            applicant: applicant.applicant,
            milestone_index,
            amount_disbursed: amount,
            ticket_awarded: applicant.ticket_awarded,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION CONTEXTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeCampaign<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + CampaignState::LEN,
        seeds = [b"rumbo_campaign", admin.key().as_ref()],
        bump
    )]
    pub campaign: Account<'info, CampaignState>,

    pub vault_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        seeds = [b"rumbo_vault", admin.key().as_ref()],
        bump,
        token::mint = vault_mint,
        token::authority = vault,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct FundEscrow<'info> {
    #[account(
        mut,
        seeds = [b"rumbo_campaign", campaign.admin.as_ref()],
        bump = campaign.bump
    )]
    pub campaign: Account<'info, CampaignState>,

    #[account(
        mut,
        seeds = [b"rumbo_vault", campaign.admin.as_ref()],
        bump = campaign.vault_bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub funder: Signer<'info>,

    #[account(
        mut,
        constraint = funder_token_account.mint == campaign.vault_mint,
        constraint = funder_token_account.owner == funder.key()
    )]
    pub funder_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ApplyGrant<'info> {
    #[account(
        seeds = [b"rumbo_campaign", campaign.admin.as_ref()],
        bump = campaign.bump
    )]
    pub campaign: Account<'info, CampaignState>,

    #[account(
        init,
        payer = applicant,
        space = 8 + GrantApplicationState::LEN,
        seeds = [b"grant_applicant", campaign.key().as_ref(), applicant.key().as_ref()],
        bump
    )]
    pub grant_application: Account<'info, GrantApplicationState>,

    #[account(mut)]
    pub applicant: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(milestone_index: u8)]
pub struct SubmitMilestoneProof<'info> {
    #[account(
        mut,
        seeds = [b"grant_applicant", grant_application.campaign.as_ref(), applicant.key().as_ref()],
        bump = grant_application.bump,
        has_one = applicant,
    )]
    pub grant_application: Account<'info, GrantApplicationState>,

    pub applicant: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(milestone_index: u8)]
pub struct VoteMilestone<'info> {
    #[account(
        seeds = [b"rumbo_campaign", campaign.admin.as_ref()],
        bump = campaign.bump
    )]
    pub campaign: Account<'info, CampaignState>,

    #[account(
        mut,
        seeds = [b"grant_applicant", campaign.key().as_ref(), grant_application.applicant.as_ref()],
        bump = grant_application.bump
    )]
    pub grant_application: Account<'info, GrantApplicationState>,

    pub juror: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(milestone_index: u8)]
pub struct DisburseMilestoneFunds<'info> {
    #[account(
        mut,
        seeds = [b"rumbo_campaign", campaign.admin.as_ref()],
        bump = campaign.bump
    )]
    pub campaign: Account<'info, CampaignState>,

    #[account(
        mut,
        seeds = [b"rumbo_vault", campaign.admin.as_ref()],
        bump = campaign.vault_bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"grant_applicant", campaign.key().as_ref(), grant_application.applicant.as_ref()],
        bump = grant_application.bump,
        has_one = campaign
    )]
    pub grant_application: Account<'info, GrantApplicationState>,

    #[account(
        mut,
        constraint = applicant_token_account.owner == grant_application.applicant,
        constraint = applicant_token_account.mint == campaign.vault_mint
    )]
    pub applicant_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// DATA STRUCTURES
// -----------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum MilestoneStatus {
    NotStarted,
    PendingReview,
    Approved,
    Rejected,
    Disbursed,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct MilestoneState {
    pub proof_hash: [u8; 32],
    pub approvals_count: u8,
    pub approving_jurors: [Pubkey; MAX_JURY_MEMBERS],
    pub status: MilestoneStatus,
}

#[account]
pub struct CampaignState {
    pub admin: Pubkey,
    pub vault_mint: Pubkey,
    pub vault: Pubkey,
    pub quorum_required: u8,
    pub total_ticket_quota: u32,
    pub allocated_tickets: u32,
    pub total_funds_allocated: u64,
    pub jury_members: Vec<Pubkey>,
    pub bump: u8,
    pub vault_bump: u8,
}

impl CampaignState {
    pub const LEN: usize = 32 + 32 + 32 + 1 + 4 + 4 + 8 + 4 + (MAX_JURY_MEMBERS * 32) + 1 + 1;
}

#[account]
pub struct GrantApplicationState {
    pub applicant: Pubkey,
    pub campaign: Pubkey,
    pub stipend_total: u64,
    pub stipend_claimed: u64,
    pub application_hash: [u8; 32],
    pub current_milestone: u8,
    pub ticket_awarded: bool,
    pub milestones: [MilestoneState; MILESTONES_COUNT],
    pub bump: u8,
}

impl GrantApplicationState {
    // 32 (pubkey) + 32 (pubkey) + 8 + 8 + 32 + 1 + 1 + (3 * (32 + 1 + (5 * 32) + 1)) + 1
    pub const LEN: usize = 32 + 32 + 8 + 8 + 32 + 1 + 1 + (3 * (32 + 1 + 160 + 1)) + 1;
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct CampaignInitializedEvent {
    pub admin: Pubkey,
    pub total_ticket_quota: u32,
    pub quorum_required: u8,
}

#[event]
pub struct EscrowFundedEvent {
    pub funder: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ApplicationSubmittedEvent {
    pub applicant: Pubkey,
    pub stipend_total: u64,
    pub application_hash: [u8; 32],
}

#[event]
pub struct MilestoneProofSubmittedEvent {
    pub applicant: Pubkey,
    pub milestone_index: u8,
    pub proof_hash: [u8; 32],
}

#[event]
pub struct MilestoneVotedEvent {
    pub applicant: Pubkey,
    pub juror: Pubkey,
    pub milestone_index: u8,
    pub approved: bool,
    pub approvals_count: u8,
}

#[event]
pub struct FundsDisbursedEvent {
    pub applicant: Pubkey,
    pub milestone_index: u8,
    pub amount_disbursed: u64,
    pub ticket_awarded: bool,
}

#[error_code]
pub enum RumboError {
    #[msg("Amount must be greater than zero.")]
    InvalidAmount,
    #[msg("Jury quorum must be greater than zero and less than or equal to member count.")]
    InvalidQuorum,
    #[msg("Cannot exceed maximum jury capacity.")]
    TooManyJuryMembers,
    #[msg("Milestone index out of bounds.")]
    InvalidMilestoneIndex,
    #[msg("Previous milestone not fully disbursed.")]
    MilestoneSequenceViolation,
    #[msg("Milestone is not in a valid state for this action.")]
    InvalidMilestoneState,
    #[msg("Caller is not an authorized jury member.")]
    UnauthorizedJuror,
    #[msg("Milestone is not currently awaiting review.")]
    MilestoneNotUnderReview,
    #[msg("Juror has already cast a vote for this milestone.")]
    DuplicateVote,
    #[msg("Milestone has not yet reached approval quorum.")]
    MilestoneNotApproved,
    #[msg("Breakpoint 2026 ticket quota has been fully exhausted.")]
    TicketsExhausted,
    #[msg("Math arithmetic overflow.")]
    MathOverflow,
}