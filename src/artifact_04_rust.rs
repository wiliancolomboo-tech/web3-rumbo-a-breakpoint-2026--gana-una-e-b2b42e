use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("RumboeB1GKT1W417FkWsAevjPzDk36UuG2iZ1s6hZhn");

pub const DISCRIMINATOR_LENGTH: usize = 8;
pub const MAX_NAME_LEN: usize = 64;
pub const MAX_CID_LEN: usize = 64;
pub const MAX_COMMITTEE_MEMBERS: usize = 7;

#[program]
pub mod rumbo_breakpoint {
    use super::*;

    /// Initializes a new Breakpoint Grant Campaign with funding target and committee.
    pub fn initialize_campaign(
        ctx: Context<InitializeCampaign>,
        campaign_id: u64,
        name: String,
        approval_threshold: u8,
        grant_amount_per_winner: u64,
        committee: Vec<Pubkey>,
    ) -> Result<()> {
        require!(name.len() <= MAX_NAME_LEN, ErrorCode::StringTooLong);
        require!(
            !committee.is_empty() && committee.len() <= MAX_COMMITTEE_MEMBERS,
            ErrorCode::InvalidCommitteeSize
        );
        require!(
            approval_threshold > 0 && approval_threshold as usize <= committee.len(),
            ErrorCode::InvalidThreshold
        );

        let campaign = &mut ctx.accounts.campaign;
        campaign.admin = ctx.accounts.admin.key();
        campaign.campaign_id = campaign_id;
        campaign.name = name;
        campaign.vault_bump = ctx.bumps.vault;
        campaign.token_mint = ctx.accounts.token_mint.key();
        campaign.grant_amount_per_winner = grant_amount_per_winner;
        campaign.approval_threshold = approval_threshold;
        campaign.committee = committee;
        campaign.total_allocated = 0;
        campaign.total_disbursed = 0;
        campaign.is_active = true;

        emit!(CampaignInitialized {
            campaign_id,
            admin: campaign.admin,
            grant_amount: grant_amount_per_winner,
        });

        Ok(())
    }

    /// Builder applies for a Breakpoint grant submitting proof of work / proposal CID.
    pub fn register_applicant(
        ctx: Context<RegisterApplicant>,
        campaign_id: u64,
        metadata_cid: String,
    ) -> Result<()> {
        require!(metadata_cid.len() <= MAX_CID_LEN, ErrorCode::StringTooLong);
        let campaign = &ctx.accounts.campaign;
        require!(campaign.is_active, ErrorCode::CampaignInactive);

        let applicant = &mut ctx.accounts.applicant_record;
        applicant.campaign_id = campaign_id;
        applicant.applicant = ctx.accounts.applicant.key();
        applicant.metadata_cid = metadata_cid.clone();
        applicant.approvals_count = 0;
        applicant.voters = Vec::new();
        applicant.is_approved = false;
        applicant.milestone_1_claimed = false; // 50% Travel Escrow
        applicant.milestone_2_claimed = false; // 50% On-site Check-in + Ticket Allocation

        emit!(ApplicantRegistered {
            campaign_id,
            applicant: applicant.applicant,
            metadata_cid,
        });

        Ok(())
    }

    /// Committee member records transparent review score/vote for an applicant.
    pub fn vote_applicant(ctx: Context<VoteApplicant>, campaign_id: u64) -> Result<()> {
        let campaign = &ctx.accounts.campaign;
        let voter = ctx.accounts.committee_member.key();
        require!(campaign.is_active, ErrorCode::CampaignInactive);
        require!(
            campaign.committee.contains(&voter),
            ErrorCode::UnauthorizedCommitteeMember
        );

        let applicant = &mut ctx.accounts.applicant_record;
        require!(!applicant.voters.contains(&voter), ErrorCode::AlreadyVoted);

        applicant.voters.push(voter);
        applicant.approvals_count = applicant.approvals_count.checked_add(1).ok_or(ErrorCode::NumericalOverflow)?;

        if applicant.approvals_count >= campaign.approval_threshold && !applicant.is_approved {
            applicant.is_approved = true;
            emit!(ApplicantApproved {
                campaign_id,
                applicant: applicant.applicant,
            });
        }

        emit!(VoteCast {
            campaign_id,
            applicant: applicant.applicant,
            voter,
            current_approvals: applicant.approvals_count,
        });

        Ok(())
    }

    /// Claim Milestone 1: 50% of the travel grant upon submitting flight verification proof.
    pub fn claim_milestone_1(ctx: Context<ClaimMilestone>, campaign_id: u64) -> Result<()> {
        let applicant_record = &mut ctx.accounts.applicant_record;
        require!(applicant_record.is_approved, ErrorCode::NotApproved);
        require!(!applicant_record.milestone_1_claimed, ErrorCode::MilestoneAlreadyClaimed);

        let campaign = &mut ctx.accounts.campaign;
        let disbursement_amount = campaign.grant_amount_per_winner / 2;

        applicant_record.milestone_1_claimed = true;
        campaign.total_disbursed = campaign.total_disbursed
            .checked_add(disbursement_amount)
            .ok_or(ErrorCode::NumericalOverflow)?;

        // Execute CPI from PDA vault to applicant token account
        let seeds = &[
            b"campaign_vault".as_ref(),
            campaign.to_account_info().key.as_ref(),
            &[campaign.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.applicant_token_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(cpi_ctx, disbursement_amount)?;

        emit!(MilestoneDisbursed {
            campaign_id,
            applicant: applicant_record.applicant,
            milestone_id: 1,
            amount: disbursement_amount,
        });

        Ok(())
    }

    /// Claim Milestone 2: Remaining 50% + ticket voucher confirmation upon arrival at Breakpoint.
    pub fn claim_milestone_2(ctx: Context<ClaimMilestone>, campaign_id: u64) -> Result<()> {
        let applicant_record = &mut ctx.accounts.applicant_record;
        require!(applicant_record.is_approved, ErrorCode::NotApproved);
        require!(applicant_record.milestone_1_claimed, ErrorCode::PrecedingMilestoneRequired);
        require!(!applicant_record.milestone_2_claimed, ErrorCode::MilestoneAlreadyClaimed);

        let campaign = &mut ctx.accounts.campaign;
        let disbursement_amount = campaign.grant_amount_per_winner - (campaign.grant_amount_per_winner / 2);

        applicant_record.milestone_2_claimed = true;
        campaign.total_disbursed = campaign.total_disbursed
            .checked_add(disbursement_amount)
            .ok_or(ErrorCode::NumericalOverflow)?;

        let seeds = &[
            b"campaign_vault".as_ref(),
            campaign.to_account_info().key.as_ref(),
            &[campaign.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.applicant_token_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(cpi_ctx, disbursement_amount)?;

        emit!(MilestoneDisbursed {
            campaign_id,
            applicant: applicant_record.applicant,
            milestone_id: 2,
            amount: disbursement_amount,
        });

        Ok(())
    }

    /// Admin can withdraw unspent funds after campaign closure.
    pub fn emergency_withdraw(ctx: Context<EmergencyWithdraw>, campaign_id: u64) -> Result<()> {
        let campaign = &ctx.accounts.campaign;
        let balance = ctx.accounts.vault.amount;

        let seeds = &[
            b"campaign_vault".as_ref(),
            campaign.to_account_info().key.as_ref(),
            &[campaign.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.admin_token_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(cpi_ctx, balance)?;

        emit!(EmergencyClawback {
            campaign_id,
            recipient: ctx.accounts.admin.key(),
            amount: balance,
        });

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Account Contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(campaign_id: u64)]
pub struct InitializeCampaign<'info> {
    #[account(
        init,
        payer = admin,
        space = DISCRIMINATOR_LENGTH + CampaignState::INIT_SPACE,
        seeds = [b"campaign", campaign_id.to_le_bytes().as_ref()],
        bump
    )]
    pub campaign: Account<'info, CampaignState>,

    #[account(
        init,
        payer = admin,
        seeds = [b"campaign_vault", campaign.key().as_ref()],
        bump,
        token::mint = token_mint,
        token::authority = vault
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_mint: Account<'info, Mint>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(campaign_id: u64)]
pub struct RegisterApplicant<'info> {
    #[account(
        mut,
        seeds = [b"campaign", campaign_id.to_le_bytes().as_ref()],
        bump
    )]
    pub campaign: Account<'info, CampaignState>,

    #[account(
        init,
        payer = applicant,
        space = DISCRIMINATOR_LENGTH + ApplicantRecord::INIT_SPACE,
        seeds = [b"applicant", campaign.key().as_ref(), applicant.key().as_ref()],
        bump
    )]
    pub applicant_record: Account<'info, ApplicantRecord>,

    #[account(mut)]
    pub applicant: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(campaign_id: u64)]
pub struct VoteApplicant<'info> {
    #[account(
        seeds = [b"campaign", campaign_id.to_le_bytes().as_ref()],
        bump
    )]
    pub campaign: Account<'info, CampaignState>,

    #[account(
        mut,
        seeds = [b"applicant", campaign.key().as_ref(), applicant_record.applicant.as_ref()],
        bump
    )]
    pub applicant_record: Account<'info, ApplicantRecord>,

    pub committee_member: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(campaign_id: u64)]
pub struct ClaimMilestone<'info> {
    #[account(
        mut,
        seeds = [b"campaign", campaign_id.to_le_bytes().as_ref()],
        bump
    )]
    pub campaign: Account<'info, CampaignState>,

    #[account(
        mut,
        seeds = [b"applicant", campaign.key().as_ref(), applicant_record.applicant.as_ref()],
        bump,
        has_one = applicant
    )]
    pub applicant_record: Account<'info, ApplicantRecord>,

    #[account(
        mut,
        seeds = [b"campaign_vault", campaign.key().as_ref()],
        bump = campaign.vault_bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = applicant_token_account.owner == applicant.key(),
        constraint = applicant_token_account.mint == campaign.token_mint
    )]
    pub applicant_token_account: Account<'info, TokenAccount>,

    pub applicant: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(campaign_id: u64)]
pub struct EmergencyWithdraw<'info> {
    #[account(
        mut,
        seeds = [b"campaign", campaign_id.to_le_bytes().as_ref()],
        bump,
        has_one = admin
    )]
    pub campaign: Account<'info, CampaignState>,

    #[account(
        mut,
        seeds = [b"campaign_vault", campaign.key().as_ref()],
        bump = campaign.vault_bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = admin_token_account.owner == admin.key(),
        constraint = admin_token_account.mint == campaign.token_mint
    )]
    pub admin_token_account: Account<'info, TokenAccount>,

    pub admin: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

// ---------------------------------------------------------------------------
// State Structures
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct CampaignState {
    pub admin: Pubkey,
    pub campaign_id: u64,
    #[max_len(64)]
    pub name: String,
    pub vault_bump: u8,
    pub token_mint: Pubkey,
    pub grant_amount_per_winner: u64,
    pub approval_threshold: u8,
    #[max_len(7)]
    pub committee: Vec<Pubkey>,
    pub total_allocated: u64,
    pub total_disbursed: u64,
    pub is_active: bool,
}

#[account]
#[derive(InitSpace)]
pub struct ApplicantRecord {
    pub campaign_id: u64,
    pub applicant: Pubkey,
    #[max_len(64)]
    pub metadata_cid: String,
    pub approvals_count: u8,
    #[max_len(7)]
    pub voters: Vec<Pubkey>,
    pub is_approved: bool,
    pub milestone_1_claimed: bool,
    pub milestone_2_claimed: bool,
}

// ---------------------------------------------------------------------------
// Events & Errors
// ---------------------------------------------------------------------------

#[event]
pub struct CampaignInitialized {
    pub campaign_id: u64,
    pub admin: Pubkey,
    pub grant_amount: u64,
}

#[event]
pub struct ApplicantRegistered {
    pub campaign_id: u64,
    pub applicant: Pubkey,
    pub metadata_cid: String,
}

#[event]
pub struct VoteCast {
    pub campaign_id: u64,
    pub applicant: Pubkey,
    pub voter: Pubkey,
    pub current_approvals: u8,
}

#[event]
pub struct ApplicantApproved {
    pub campaign_id: u64,
    pub applicant: Pubkey,
}

#[event]
pub struct MilestoneDisbursed {
    pub campaign_id: u64,
    pub applicant: Pubkey,
    pub milestone_id: u8,
    pub amount: u64,
}

#[event]
pub struct EmergencyClawback {
    pub campaign_id: u64,
    pub recipient: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("String exceeds maximum permitted length.")]
    StringTooLong,
    #[msg("Invalid committee size. Must be between 1 and 7 members.")]
    InvalidCommitteeSize,
    #[msg("Invalid approval threshold specified.")]
    InvalidThreshold,
    #[msg("Campaign is currently inactive.")]
    CampaignInactive,
    #[msg("Voter is not an authorized committee member.")]
    UnauthorizedCommitteeMember,
    #[msg("Committee member has already cast a vote for this candidate.")]
    AlreadyVoted,
    #[msg("Candidate has not yet been approved by committee threshold.")]
    NotApproved,
    #[msg("Requested milestone has already been claimed.")]
    MilestoneAlreadyClaimed,
    #[msg("Preceding milestone verification must be satisfied first.")]
    PrecedingMilestoneRequired,
    #[msg("Numerical overflow encountered.")]
    NumericalOverflow,
}