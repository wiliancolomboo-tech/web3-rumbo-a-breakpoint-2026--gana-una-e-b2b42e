use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

declare_id!("RumbobREAk202611111111111111111111111111111");

#[program]
pub mod rumbo_protocol {
    use super::*;

    /// Initialize the Breakpoint 2026 Campaign Escrow
    pub fn initialize_campaign(
        ctx: Context<InitializeCampaign>,
        campaign_id: String,
        ticket_quota: u32,
        grant_per_builder: u64,
        travel_deadline: i64,
    ) -> Result<()> {
        require!(campaign_id.len() <= 32, RumboError::StringTooLong);
        require!(grant_per_builder > 0, RumboError::InvalidGrantAmount);
        require!(
            travel_deadline > Clock::get()?.unix_timestamp,
            RumboError::InvalidDeadline
        );

        let campaign = &mut ctx.accounts.campaign;
        campaign.authority = ctx.accounts.authority.key();
        campaign.campaign_id = campaign_id;
        campaign.ticket_quota = ticket_quota;
        campaign.tickets_issued = 0;
        campaign.grant_per_builder = grant_per_builder;
        campaign.travel_deadline = travel_deadline;
        campaign.total_recipients = 0;
        campaign.vault_bump = ctx.bumps.vault;
        campaign.bump = ctx.bumps.campaign;

        emit!(CampaignInitialized {
            campaign: campaign.key(),
            authority: campaign.authority,
            ticket_quota,
            grant_per_builder,
            travel_deadline,
        });

        Ok(())
    }

    /// Register a builder applying for Breakpoint 2026 travel support
    pub fn register_applicant(
        ctx: Context<RegisterApplicant>,
        metadata_hash: [u8; 32],
        applicant_name: String,
        origin_city: String,
    ) -> Result<()> {
        require!(applicant_name.len() <= 64, RumboError::StringTooLong);
        require!(origin_city.len() <= 32, RumboError::StringTooLong);

        let applicant = &mut ctx.accounts.applicant;
        applicant.builder = ctx.accounts.builder.key();
        applicant.campaign = ctx.accounts.campaign.key();
        applicant.metadata_hash = metadata_hash;
        applicant.applicant_name = applicant_name;
        applicant.origin_city = origin_city;
        applicant.milestone_stage = MilestoneStage::Registered;
        applicant.travel_grant_claimed = 0;
        applicant.ticket_issued = false;
        applicant.bump = ctx.bumps.applicant;

        let campaign = &mut ctx.accounts.campaign;
        campaign.total_recipients = campaign.total_recipients.checked_add(1).unwrap();

        emit!(ApplicantRegistered {
            campaign: campaign.key(),
            builder: applicant.builder,
            metadata_hash,
        });

        Ok(())
    }

    /// Builder submits milestone proof (e.g. proof of flights, visa, or shipped Solana demo)
    pub fn submit_milestone(
        ctx: Context<SubmitMilestone>,
        proof_hash: [u8; 32],
        stage: MilestoneStage,
    ) -> Result<()> {
        let applicant = &mut ctx.accounts.applicant;
        require!(
            ctx.accounts.builder.key() == applicant.builder,
            RumboError::Unauthorized
        );
        require!(
            stage > applicant.milestone_stage,
            RumboError::InvalidMilestoneProgression
        );

        applicant.pending_proof_hash = proof_hash;
        applicant.milestone_stage = stage;

        emit!(MilestoneSubmitted {
            builder: applicant.builder,
            stage,
            proof_hash,
        });

        Ok(())
    }

    /// Authorized committee judges sign off on builder deliverables
    pub fn attest_and_approve(
        ctx: Context<AttestMilestone>,
        approved_stage: MilestoneStage,
        score: u8,
    ) -> Result<()> {
        require!(score >= 70, RumboError::ScoreBelowThreshold);
        let applicant = &mut ctx.accounts.applicant;
        let campaign = &ctx.accounts.campaign;

        require!(
            applicant.milestone_stage == approved_stage,
            RumboError::MilestoneStageMismatch
        );

        applicant.verified_stage = approved_stage;

        emit!(MilestoneApproved {
            campaign: campaign.key(),
            builder: applicant.builder,
            approved_stage,
            score,
            approver: ctx.accounts.judge.key(),
        });

        Ok(())
    }

    /// Builder claims approved funds from the PDA vault
    pub fn claim_travel_grant(ctx: Context<ClaimTravelGrant>) -> Result<()> {
        let campaign = &ctx.accounts.campaign;
        let applicant = &mut ctx.accounts.applicant;
        let clock = Clock::get()?;

        require!(
            clock.unix_timestamp <= campaign.travel_deadline,
            RumboError::DeadlineExceeded
        );

        let payout_amount: u64 = match applicant.verified_stage {
            MilestoneStage::VisaAndFlightBooked => {
                // Disburse 50% for logistical booking
                campaign.grant_per_builder / 2
            }
            MilestoneStage::OnSiteVerified => {
                // Remaining 50% released
                campaign.grant_per_builder - applicant.travel_grant_claimed
            }
            _ => return Err(RumboError::MilestoneNotEligibleForPayout.into()),
        };

        require!(payout_amount > 0, RumboError::NothingToClaim);
        require!(
            applicant.travel_grant_claimed.checked_add(payout_amount).unwrap()
                <= campaign.grant_per_builder,
            RumboError::OverAllocation
        );

        let vault_lamports = ctx.accounts.vault.to_account_info().lamports();
        require!(vault_lamports >= payout_amount, RumboError::InsufficientVaultFunds);

        // Execute CPI transfer from PDA vault
        let campaign_id_bytes = campaign.campaign_id.as_bytes();
        let seeds = &[
            b"vault",
            campaign_id_bytes,
            &[campaign.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.builder.to_account_info(),
                },
                signer_seeds,
            ),
            payout_amount,
        )?;

        applicant.travel_grant_claimed = applicant
            .travel_grant_claimed
            .checked_add(payout_amount)
            .unwrap();

        emit!(GrantDisbursed {
            campaign: campaign.key(),
            builder: applicant.builder,
            amount: payout_amount,
            total_claimed: applicant.travel_grant_claimed,
        });

        Ok(())
    }

    /// Issue non-transferable Soulbound Breakpoint Ticket Voucher PDA
    pub fn issue_ticket_voucher(ctx: Context<IssueTicketVoucher>) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        let applicant = &mut ctx.accounts.applicant;
        let voucher = &mut ctx.accounts.voucher;

        require!(
            campaign.tickets_issued < campaign.ticket_quota,
            RumboError::TicketQuotaExceeded
        );
        require!(
            applicant.verified_stage >= MilestoneStage::VisaAndFlightBooked,
            RumboError::ApplicantNotVerifiedForTicket
        );
        require!(!applicant.ticket_issued, RumboError::TicketAlreadyIssued);

        voucher.campaign = campaign.key();
        voucher.recipient = applicant.builder;
        voucher.ticket_number = campaign.tickets_issued + 1;
        voucher.issued_at = Clock::get()?.unix_timestamp;
        voucher.is_claimed = true;
        voucher.bump = ctx.bumps.voucher;

        applicant.ticket_issued = true;
        campaign.tickets_issued = campaign.tickets_issued.checked_add(1).unwrap();

        emit!(TicketVoucherIssued {
            campaign: campaign.key(),
            builder: applicant.builder,
            ticket_number: voucher.ticket_number,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// Account Contexts
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(campaign_id: String)]
pub struct InitializeCampaign<'info> {
    #[account(
        init,
        payer = authority,
        space = Campaign::LEN,
        seeds = [b"campaign", campaign_id.as_bytes()],
        bump
    )]
    pub campaign: Account<'info, Campaign>,

    /// CHECK: Safe PDA acting as autonomous native lamport vault
    #[account(
        mut,
        seeds = [b"vault", campaign_id.as_bytes()],
        bump
    )]
    pub vault: SystemAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterApplicant<'info> {
    #[account(
        init,
        payer = builder,
        space = Applicant::LEN,
        seeds = [b"applicant", campaign.key().as_ref(), builder.key().as_ref()],
        bump
    )]
    pub applicant: Account<'info, Applicant>,

    #[account(mut)]
    pub campaign: Account<'info, Campaign>,

    #[account(mut)]
    pub builder: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SubmitMilestone<'info> {
    #[account(
        mut,
        seeds = [b"applicant", campaign.key().as_ref(), builder.key().as_ref()],
        bump = applicant.bump
    )]
    pub applicant: Account<'info, Applicant>,

    pub campaign: Account<'info, Campaign>,

    pub builder: Signer<'info>,
}

#[derive(Accounts)]
pub struct AttestMilestone<'info> {
    #[account(
        mut,
        seeds = [b"applicant", campaign.key().as_ref(), applicant.builder.as_ref()],
        bump = applicant.bump
    )]
    pub applicant: Account<'info, Applicant>,

    pub campaign: Account<'info, Campaign>,

    #[account(
        constraint = judge.key() == campaign.authority @ RumboError::UnauthorizedJudge
    )]
    pub judge: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimTravelGrant<'info> {
    #[account(
        mut,
        seeds = [b"campaign", campaign.campaign_id.as_bytes()],
        bump = campaign.bump
    )]
    pub campaign: Account<'info, Campaign>,

    #[account(
        mut,
        seeds = [b"applicant", campaign.key().as_ref(), builder.key().as_ref()],
        bump = applicant.bump
    )]
    pub applicant: Account<'info, Applicant>,

    /// CHECK: PDA vault authority checked via seeds
    #[account(
        mut,
        seeds = [b"vault", campaign.campaign_id.as_bytes()],
        bump = campaign.vault_bump
    )]
    pub vault: SystemAccount<'info>,

    #[account(mut, address = applicant.builder)]
    pub builder: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct IssueTicketVoucher<'info> {
    #[account(
        mut,
        seeds = [b"campaign", campaign.campaign_id.as_bytes()],
        bump = campaign.bump
    )]
    pub campaign: Account<'info, Campaign>,

    #[account(
        mut,
        seeds = [b"applicant", campaign.key().as_ref(), applicant.builder.as_ref()],
        bump = applicant.bump
    )]
    pub applicant: Account<'info, Applicant>,

    #[account(
        init,
        payer = authority,
        space = TicketVoucher::LEN,
        seeds = [b"voucher", campaign.key().as_ref(), applicant.builder.as_ref()],
        bump
    )]
    pub voucher: Account<'info, TicketVoucher>,

    #[account(
        mut,
        constraint = authority.key() == campaign.authority @ RumboError::Unauthorized
    )]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// -----------------------------------------------------------------------------
// State Structures
// -----------------------------------------------------------------------------

#[account]
pub struct Campaign {
    pub authority: Pubkey,          // 32
    pub campaign_id: String,        // 4 + 32
    pub ticket_quota: u32,          // 4
    pub tickets_issued: u32,        // 4
    pub grant_per_builder: u64,     // 8
    pub travel_deadline: i64,       // 8
    pub total_recipients: u32,      // 4
    pub vault_bump: u8,             // 1
    pub bump: u8,                   // 1
}

impl Campaign {
    pub const LEN: usize = 8 + 32 + (4 + 32) + 4 + 4 + 8 + 8 + 4 + 1 + 1 + 64;
}

#[account]
pub struct Applicant {
    pub builder: Pubkey,                  // 32
    pub campaign: Pubkey,                 // 32
    pub metadata_hash: [u8; 32],          // 32
    pub applicant_name: String,           // 4 + 64
    pub origin_city: String,              // 4 + 32
    pub milestone_stage: MilestoneStage,  // 1
    pub verified_stage: MilestoneStage,   // 1
    pub pending_proof_hash: [u8; 32],     // 32
    pub travel_grant_claimed: u64,        // 8
    pub ticket_issued: bool,              // 1
    pub bump: u8,                         // 1
}

impl Applicant {
    pub const LEN: usize = 8 + 32 + 32 + 32 + (4 + 64) + (4 + 32) + 1 + 1 + 32 + 8 + 1 + 1 + 64;
}

#[account]
pub struct TicketVoucher {
    pub campaign: Pubkey,       // 32
    pub recipient: Pubkey,      // 32
    pub ticket_number: u32,     // 4
    pub issued_at: i64,         // 8
    pub is_claimed: bool,       // 1
    pub bump: u8,               // 1
}

impl TicketVoucher {
    pub const LEN: usize = 8 + 32 + 32 + 4 + 8 + 1 + 1 + 32;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum MilestoneStage {
    None = 0,
    Registered = 1,
    ProjectSubmitted = 2,
    VisaAndFlightBooked = 3,
    OnSiteVerified = 4,
}

// -----------------------------------------------------------------------------
// Events & Errors
// -----------------------------------------------------------------------------

#[event]
pub struct CampaignInitialized {
    pub campaign: Pubkey,
    pub authority: Pubkey,
    pub ticket_quota: u32,
    pub grant_per_builder: u64,
    pub travel_deadline: i64,
}

#[event]
pub struct ApplicantRegistered {
    pub campaign: Pubkey,
    pub builder: Pubkey,
    pub metadata_hash: [u8; 32],
}

#[event]
pub struct MilestoneSubmitted {
    pub builder: Pubkey,
    pub stage: MilestoneStage,
    pub proof_hash: [u8; 32],
}

#[event]
pub struct MilestoneApproved {
    pub campaign: Pubkey,
    pub builder: Pubkey,
    pub approved_stage: MilestoneStage,
    pub score: u8,
    pub approver: Pubkey,
}

#[event]
pub struct GrantDisbursed {
    pub campaign: Pubkey,
    pub builder: Pubkey,
    pub amount: u64,
    pub total_claimed: u64,
}

#[event]
pub struct TicketVoucherIssued {
    pub campaign: Pubkey,
    pub builder: Pubkey,
    pub ticket_number: u32,
}

#[error_code]
pub enum RumboError {
    #[msg("String provided exceeds the maximum allowed length")]
    StringTooLong,
    #[msg("Grant amount per builder must be greater than zero")]
    InvalidGrantAmount,
    #[msg("Campaign deadline must be in the future")]
    InvalidDeadline,
    #[msg("You are not authorized to perform this operation")]
    Unauthorized,
    #[msg("Signer is not an authorized judge for this campaign")]
    UnauthorizedJudge,
    #[msg("Applicant cannot skip intermediate milestone stages")]
    InvalidMilestoneProgression,
    #[msg("Attestation score is below the passing requirement (70)")]
    ScoreBelowThreshold,
    #[msg("Submitted stage does not match verified milestone")]
    MilestoneStageMismatch,
    #[msg("Campaign deadline has elapsed")]
    DeadlineExceeded,
    #[msg("Current milestone level is not eligible for disbursement")]
    MilestoneNotEligibleForPayout,
    #[msg("No lamports eligible to claim")]
    NothingToClaim,
    #[msg("Claim amount exceeds granted allocation")]
    OverAllocation,
    #[msg("The vault escrow does not hold sufficient lamports")]
    InsufficientVaultFunds,
    #[msg("All Breakpoint tickets for this campaign have been allocated")]
    TicketQuotaExceeded,
    #[msg("Applicant must reach Visa & Flight validation before ticket issuance")]
    ApplicantNotVerifiedForTicket,
    #[msg("Breakpoint 2026 Ticket Voucher has already been minted")]
    TicketAlreadyIssued,
}