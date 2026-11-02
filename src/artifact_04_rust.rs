use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

declare_id!("RumbokZ3JcQWjC1E4uV4bZzK9f4w4hE2n8z1yX7pL5q");

pub const DISCRIMINATOR_LENGTH: usize = 8;
pub const MAX_NAME_LEN: usize = 64;
pub const MAX_METADATA_LEN: usize = 128;
pub const COMMITTEE_ROLE: u8 = 1;

#[program]
pub mod rumbo_breakpoint {
    use super::*;

    /// Initialize the Breakpoint Campaign Season
    pub fn initialize_campaign(
        ctx: Context<InitializeCampaign>,
        season_id: u32,
        max_tickets: u32,
        total_stipend_cap_lamports: u64,
        min_score_threshold: u8,
    ) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        campaign.admin = ctx.accounts.admin.key();
        campaign.season_id = season_id;
        campaign.max_tickets = max_tickets;
        campaign.tickets_awarded = 0;
        campaign.total_stipend_cap = total_stipend_cap_lamports;
        campaign.total_stipend_disbursed = 0;
        campaign.min_score_threshold = min_score_threshold;
        campaign.bump = ctx.bumps.campaign;
        campaign.vault_bump = ctx.bumps.vault;

        emit!(CampaignInitializedEvent {
            season_id,
            admin: ctx.accounts.admin.key(),
            total_stipend_cap: total_stipend_cap_lamports,
            max_tickets,
        });

        Ok(())
    }

    /// Builder applies for a travel stipend and Breakpoint 2026 Ticket
    pub fn apply_for_grant(
        ctx: Context<ApplyForGrant>,
        legal_name: String,
        github_handle: String,
        project_commit_hash: [u8; 32],
        requested_stipend_lamports: u64,
    ) -> Result<()> {
        require!(
            legal_name.as_bytes().len() <= MAX_NAME_LEN,
            RumboError::NameTooLong
        );
        require!(
            github_handle.as_bytes().len() <= MAX_NAME_LEN,
            RumboError::HandleTooLong
        );
        require!(
            requested_stipend_lamports > 0,
            RumboError::InvalidRequestedAmount
        );

        let application = &mut ctx.accounts.application;
        application.applicant = ctx.accounts.applicant.key();
        application.campaign = ctx.accounts.campaign.key();
        application.legal_name = legal_name.clone();
        application.github_handle = github_handle.clone();
        application.project_commit_hash = project_commit_hash;
        application.requested_stipend = requested_stipend_lamports;
        application.approved_stipend = 0;
        application.score = 0;
        application.status = ApplicationStatus::Submitted;
        application.ticket_claimed = false;
        application.bump = ctx.bumps.application;

        emit!(GrantAppliedEvent {
            applicant: ctx.accounts.applicant.key(),
            campaign: ctx.accounts.campaign.key(),
            github_handle,
            requested_stipend: requested_stipend_lamports,
        });

        Ok(())
    }

    /// Authorized Committee member attests to the candidate's contribution and assigns a score
    pub fn attest_contribution(
        ctx: Context<AttestContribution>,
        score: u8,
        approved_stipend_lamports: u64,
    ) -> Result<()> {
        require!(score <= 100, RumboError::InvalidScore);

        let campaign = &ctx.accounts.campaign;
        let application = &mut ctx.accounts.application;

        require!(
            application.status == ApplicationStatus::Submitted,
            RumboError::ApplicationAlreadyProcessed
        );

        application.score = score;

        if score >= campaign.min_score_threshold {
            require!(
                campaign.total_stipend_disbursed + approved_stipend_lamports <= campaign.total_stipend_cap,
                RumboError::StipendCapExceeded
            );
            application.status = ApplicationStatus::Approved;
            application.approved_stipend = approved_stipend_lamports;
        } else {
            application.status = ApplicationStatus::Rejected;
            application.approved_stipend = 0;
        }

        emit!(GrantAttestedEvent {
            applicant: application.applicant,
            evaluator: ctx.accounts.evaluator.key(),
            score,
            status: application.status,
            approved_stipend: application.approved_stipend,
        });

        Ok(())
    }

    /// Releases the approved travel stipend directly from the Campaign Vault PDA to the builder
    pub fn disburse_travel_stipend(ctx: Context<DisburseTravelStipend>) -> Result<()> {
        let application = &mut ctx.accounts.application;
        let campaign = &mut ctx.accounts.campaign;

        require!(
            application.status == ApplicationStatus::Approved,
            RumboError::ApplicationNotApproved
        );
        require!(
            application.approved_stipend > 0,
            RumboError::NoFundsToDisburse
        );

        let amount = application.approved_stipend;
        application.approved_stipend = 0; // Prevent re-entrancy / double disbursement
        application.status = ApplicationStatus::Funded;

        campaign.total_stipend_disbursed = campaign
            .total_stipend_disbursed
            .checked_add(amount)
            .ok_or(RumboError::ArithmeticOverflow)?;

        let season_id_bytes = campaign.season_id.to_le_bytes();
        let seeds = &[
            b"campaign_vault".as_ref(),
            campaign.to_account_info().key.as_ref(),
            &[campaign.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.applicant.to_account_info(),
            },
            signer_seeds,
        );

        transfer(transfer_ctx, amount)?;

        emit!(StipendDisbursedEvent {
            applicant: ctx.accounts.applicant.key(),
            amount,
            campaign: campaign.key(),
        });

        Ok(())
    }

    /// Mints a Soulbound on-chain ticket voucher receipt PDA for entry at Breakpoint 2026
    pub fn claim_breakpoint_ticket(ctx: Context<ClaimBreakpointTicket>) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        let application = &mut ctx.accounts.application;
        let ticket = &mut ctx.accounts.ticket;

        require!(
            application.status == ApplicationStatus::Funded || application.status == ApplicationStatus::Approved,
            RumboError::ApplicationNotEligibleForTicket
        );
        require!(!application.ticket_claimed, RumboError::TicketAlreadyClaimed);
        require!(
            campaign.tickets_awarded < campaign.max_tickets,
            RumboError::TicketQuotaExceeded
        );

        application.ticket_claimed = true;
        campaign.tickets_awarded = campaign
            .tickets_awarded
            .checked_add(1)
            .ok_or(RumboError::ArithmeticOverflow)?;

        ticket.owner = ctx.accounts.applicant.key();
        ticket.campaign = campaign.key();
        ticket.ticket_number = campaign.tickets_awarded;
        ticket.issued_at = Clock::get()?.unix_timestamp;
        ticket.bump = ctx.bumps.ticket;

        emit!(TicketClaimedEvent {
            ticket_id: ticket.key(),
            owner: ticket.owner,
            ticket_number: ticket.ticket_number,
            issued_at: ticket.issued_at,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(season_id: u32)]
pub struct InitializeCampaign<'info> {
    #[account(
        init,
        payer = admin,
        space = DISCRIMINATOR_LENGTH + Campaign::INIT_SPACE,
        seeds = [b"campaign", admin.key().as_ref(), &season_id.to_le_bytes()],
        bump
    )]
    pub campaign: Account<'info, Campaign>,

    /// CHECK: PDA Treasury vault holding SOL stipends
    #[account(
        mut,
        seeds = [b"campaign_vault", campaign.key().as_ref()],
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
        space = DISCRIMINATOR_LENGTH + Application::INIT_SPACE,
        seeds = [b"application", campaign.key().as_ref(), applicant.key().as_ref()],
        bump
    )]
    pub application: Account<'info, Application>,

    pub campaign: Account<'info, Campaign>,

    #[account(mut)]
    pub applicant: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AttestContribution<'info> {
    #[account(
        mut,
        has_one = admin @ RumboError::UnauthorizedCommittee
    )]
    pub campaign: Account<'info, Campaign>,

    #[account(
        mut,
        seeds = [b"application", campaign.key().as_ref(), application.applicant.as_ref()],
        bump = application.bump
    )]
    pub application: Account<'info, Application>,

    pub admin: Signer<'info>,
    pub evaluator: Signer<'info>,
}

#[derive(Accounts)]
pub struct DisburseTravelStipend<'info> {
    #[account(mut)]
    pub campaign: Account<'info, Campaign>,

    /// CHECK: Validated via seeds in CPI transfer
    #[account(
        mut,
        seeds = [b"campaign_vault", campaign.key().as_ref()],
        bump = campaign.vault_bump
    )]
    pub vault: SystemAccount<'info>,

    #[account(
        mut,
        seeds = [b"application", campaign.key().as_ref(), applicant.key().as_ref()],
        bump = application.bump
    )]
    pub application: Account<'info, Application>,

    /// CHECK: Payout recipient
    #[account(mut, address = application.applicant)]
    pub applicant: SystemAccount<'info>,

    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimBreakpointTicket<'info> {
    #[account(mut)]
    pub campaign: Account<'info, Campaign>,

    #[account(
        mut,
        seeds = [b"application", campaign.key().as_ref(), applicant.key().as_ref()],
        bump = application.bump
    )]
    pub application: Account<'info, Application>,

    #[account(
        init,
        payer = applicant,
        space = DISCRIMINATOR_LENGTH + BreakpointTicket::INIT_SPACE,
        seeds = [b"ticket", campaign.key().as_ref(), applicant.key().as_ref()],
        bump
    )]
    pub ticket: Account<'info, BreakpointTicket>,

    #[account(mut, address = application.applicant)]
    pub applicant: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// -----------------------------------------------------------------------------
// STATE DEFINITIONS
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Campaign {
    pub admin: Pubkey,
    pub season_id: u32,
    pub max_tickets: u32,
    pub tickets_awarded: u32,
    pub total_stipend_cap: u64,
    pub total_stipend_disbursed: u64,
    pub min_score_threshold: u8,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Application {
    pub applicant: Pubkey,
    pub campaign: Pubkey,
    #[max_len(64)]
    pub legal_name: String,
    #[max_len(64)]
    pub github_handle: String,
    pub project_commit_hash: [u8; 32],
    pub requested_stipend: u64,
    pub approved_stipend: u64,
    pub score: u8,
    pub status: ApplicationStatus,
    pub ticket_claimed: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct BreakpointTicket {
    pub owner: Pubkey,
    pub campaign: Pubkey,
    pub ticket_number: u32,
    pub issued_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum ApplicationStatus {
    Submitted,
    Approved,
    Rejected,
    Funded,
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct CampaignInitializedEvent {
    pub season_id: u32,
    pub admin: Pubkey,
    pub total_stipend_cap: u64,
    pub max_tickets: u32,
}

#[event]
pub struct GrantAppliedEvent {
    pub applicant: Pubkey,
    pub campaign: Pubkey,
    pub github_handle: String,
    pub requested_stipend: u64,
}

#[event]
pub struct GrantAttestedEvent {
    pub applicant: Pubkey,
    pub evaluator: Pubkey,
    pub score: u8,
    pub status: ApplicationStatus,
    pub approved_stipend: u64,
}

#[event]
pub struct StipendDisbursedEvent {
    pub applicant: Pubkey,
    pub amount: u64,
    pub campaign: Pubkey,
}

#[event]
pub struct TicketClaimedEvent {
    pub ticket_id: Pubkey,
    pub owner: Pubkey,
    pub ticket_number: u32,
    pub issued_at: i64,
}

#[error_code]
pub enum RumboError {
    #[msg("Provided legal name exceeds maximum allowed length of 64 bytes.")]
    NameTooLong,
    #[msg("Provided GitHub handle exceeds maximum allowed length of 64 bytes.")]
    HandleTooLong,
    #[msg("Requested stipend lamports must be greater than zero.")]
    InvalidRequestedAmount,
    #[msg("Score must be an integer between 0 and 100.")]
    InvalidScore,
    #[msg("Application has already been evaluated.")]
    ApplicationAlreadyProcessed,
    #[msg("Stipend request exceeds remaining campaign treasury cap.")]
    StipendCapExceeded,
    #[msg("Application status is not approved for funding.")]
    ApplicationNotApproved,
    #[msg("No approved funds available for disbursement.")]
    NoFundsToDisburse,
    #[msg("Application does not satisfy eligibility criteria for ticket claim.")]
    ApplicationNotEligibleForTicket,
    #[msg("Breakpoint ticket already claimed by this applicant.")]
    TicketAlreadyClaimed,
    #[msg("Maximum ticket quota for Breakpoint 2026 has been reached.")]
    TicketQuotaExceeded,
    #[msg("Signer is not authorized to act as the campaign committee administrator.")]
    UnauthorizedCommittee,
    #[msg("Math arithmetic overflow.")]
    ArithmeticOverflow,
}