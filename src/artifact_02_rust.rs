use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("RumbocgN3c5i9Kq1bPnqTjH7u9pB4m2YkYhK7P8hK8k8");

#[program]
pub mod rumbo_protocol {
    use super::*;

    /// Initialize protocol configuration and admin governance
    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        verification_oracle: Pubkey,
    ) -> Result<()> {
        let protocol = &mut ctx.accounts.protocol_config;
        protocol.authority = ctx.accounts.authority.key();
        protocol.verification_oracle = verification_oracle;
        protocol.total_grants_created = 0;
        protocol.total_disbursed_lamports = 0;
        protocol.bump = ctx.bumps.protocol_config;

        emit!(ProtocolInitializedEvent {
            authority: protocol.authority,
            oracle: verification_oracle,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Create and fund a structured travel scholarship grant escrow
    pub fn create_grant(
        ctx: Context<CreateGrant>,
        grant_id: u64,
        total_amount: u64,
        num_milestones: u8,
        destination_event: String,
    ) -> Result<()> {
        require!(total_amount > 0, RumboError::InvalidAmount);
        require!(num_milestones > 0 && num_milestones <= 5, RumboError::InvalidMilestoneCount);
        require!(destination_event.len() <= 32, RumboError::StringTooLong);

        let grant = &mut ctx.accounts.grant;
        grant.grant_id = grant_id;
        grant.sponsor = ctx.accounts.sponsor.key();
        grant.recipient = ctx.accounts.recipient.key();
        grant.escrow_vault = ctx.accounts.escrow_vault.key();
        grant.token_mint = ctx.accounts.token_mint.key();
        grant.total_amount = total_amount;
        grant.released_amount = 0;
        grant.num_milestones = num_milestones;
        grant.completed_milestones = 0;
        grant.destination_event = destination_event;
        grant.is_active = true;
        grant.bump = ctx.bumps.grant;
        grant.vault_bump = ctx.bumps.escrow_vault;

        // Transfer funds from sponsor into the grant escrow vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.sponsor_token_account.to_account_info(),
            to: ctx.accounts.escrow_vault.to_account_info(),
            authority: ctx.accounts.sponsor.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(CpiContext::new(cpi_program, cpi_accounts), total_amount)?;

        let protocol = &mut ctx.accounts.protocol_config;
        protocol.total_grants_created = protocol.total_grants_created.checked_add(1).unwrap();

        emit!(GrantCreatedEvent {
            grant_id,
            sponsor: grant.sponsor,
            recipient: grant.recipient,
            total_amount,
            num_milestones,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Recipient submits proof hash (e.g. SHA-256 of GitHub PR, Devnet tx hash, or presentation)
    pub fn submit_milestone_proof(
        ctx: Context<SubmitMilestoneProof>,
        milestone_index: u8,
        proof_hash: [u8; 32],
    ) -> Result<()> {
        let grant = &ctx.accounts.grant;
        require!(grant.is_active, RumboError::GrantInactive);
        require!(ctx.accounts.recipient.key() == grant.recipient, RumboError::UnauthorizedRecipient);
        require!(milestone_index == grant.completed_milestones, RumboError::MilestoneSequenceMismatch);

        emit!(MilestoneSubmittedEvent {
            grant_id: grant.grant_id,
            recipient: grant.recipient,
            milestone_index,
            proof_hash,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Oracle/Admin validates milestone and triggers proportional milestone disbursement
    pub fn verify_and_disburse(
        ctx: Context<VerifyAndDisburse>,
        milestone_index: u8,
    ) -> Result<()> {
        let protocol = &ctx.accounts.protocol_config;
        require!(
            ctx.accounts.signer.key() == protocol.verification_oracle || ctx.accounts.signer.key() == protocol.authority,
            RumboError::UnauthorizedOracle
        );

        let grant = &mut ctx.accounts.grant;
        require!(grant.is_active, RumboError::GrantInactive);
        require!(milestone_index == grant.completed_milestones, RumboError::MilestoneSequenceMismatch);

        let milestone_payout = grant.total_amount
            .checked_div(grant.num_milestones as u64)
            .ok_or(RumboError::MathOverflow)?;

        grant.completed_milestones = grant.completed_milestones.checked_add(1).ok_or(RumboError::MathOverflow)?;
        grant.released_amount = grant.released_amount.checked_add(milestone_payout).ok_or(RumboError::MathOverflow)?;

        if grant.completed_milestones == grant.num_milestones {
            grant.is_active = false;
        }

        let grant_id_bytes = grant.grant_id.to_le_bytes();
        let seeds = &[
            b"grant_vault",
            grant_id_bytes.as_ref(),
            &[grant.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.escrow_vault.to_account_info(),
            to: ctx.accounts.recipient_token_account.to_account_info(),
            authority: ctx.accounts.escrow_vault.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(
            CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds),
            milestone_payout,
        )?;

        let protocol_mut = &mut ctx.accounts.protocol_config;
        protocol_mut.total_disbursed_lamports = protocol_mut
            .total_disbursed_lamports
            .checked_add(milestone_payout)
            .ok_or(RumboError::MathOverflow)?;

        emit!(MilestoneDisbursedEvent {
            grant_id: grant.grant_id,
            recipient: grant.recipient,
            milestone_index,
            amount_disbursed: milestone_payout,
            all_milestones_completed: !grant.is_active,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Emergency revocation by protocol authority in case of fraud
    pub fn emergency_cancel_grant(ctx: Context<EmergencyCancelGrant>) -> Result<()> {
        let grant = &mut ctx.accounts.grant;
        require!(grant.is_active, RumboError::GrantInactive);

        let remaining_balance = ctx.accounts.escrow_vault.amount;
        require!(remaining_balance > 0, RumboError::NoFundsInEscrow);

        grant.is_active = false;

        let grant_id_bytes = grant.grant_id.to_le_bytes();
        let seeds = &[
            b"grant_vault",
            grant_id_bytes.as_ref(),
            &[grant.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.escrow_vault.to_account_info(),
            to: ctx.accounts.sponsor_refund_account.to_account_info(),
            authority: ctx.accounts.escrow_vault.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(
            CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds),
            remaining_balance,
        )?;

        emit!(GrantCancelledEvent {
            grant_id: grant.grant_id,
            refund_recipient: ctx.accounts.sponsor_refund_account.key(),
            refunded_amount: remaining_balance,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub fn initialize_protocol(ctx: Context<InitializeProtocol>) -> Result<()> {
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + ProtocolConfig::INIT_SPACE,
        seeds = [b"protocol_config"],
        bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(grant_id: u64)]
pub struct CreateGrant<'info> {
    #[account(
        mut,
        seeds = [b"protocol_config"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        init,
        payer = sponsor,
        space = 8 + Grant::INIT_SPACE,
        seeds = [b"grant", grant_id.to_le_bytes().as_ref()],
        bump
    )]
    pub grant: Account<'info, Grant>,

    #[account(
        init,
        payer = sponsor,
        seeds = [b"grant_vault", grant_id.to_le_bytes().as_ref()],
        bump,
        token::mint = token_mint,
        token::authority = escrow_vault
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = sponsor_token_account.mint == token_mint.key(),
        constraint = sponsor_token_account.owner == sponsor.key()
    )]
    pub sponsor_token_account: Account<'info, TokenAccount>,

    /// CHECK: Grant recipient validated upon submission
    pub recipient: AccountInfo<'info>,

    #[account(mut)]
    pub sponsor: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct SubmitMilestoneProof<'info> {
    #[account(
        seeds = [b"grant", grant.grant_id.to_le_bytes().as_ref()],
        bump = grant.bump
    )]
    pub grant: Account<'info, Grant>,
    pub recipient: Signer<'info>,
}

#[derive(Accounts)]
pub struct VerifyAndDisburse<'info> {
    #[account(
        mut,
        seeds = [b"protocol_config"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [b"grant", grant.grant_id.to_le_bytes().as_ref()],
        bump = grant.bump
    )]
    pub grant: Account<'info, Grant>,

    #[account(
        mut,
        seeds = [b"grant_vault", grant.grant_id.to_le_bytes().as_ref()],
        bump = grant.vault_bump
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = recipient_token_account.mint == grant.token_mint,
        constraint = recipient_token_account.owner == grant.recipient
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,

    pub signer: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct EmergencyCancelGrant<'info> {
    #[account(
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
        has_one = authority
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [b"grant", grant.grant_id.to_le_bytes().as_ref()],
        bump = grant.bump
    )]
    pub grant: Account<'info, Grant>,

    #[account(
        mut,
        seeds = [b"grant_vault", grant.grant_id.to_le_bytes().as_ref()],
        bump = grant.vault_bump
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = sponsor_refund_account.mint == grant.token_mint,
        constraint = sponsor_refund_account.owner == grant.sponsor
    )]
    pub sponsor_refund_account: Account<'info, TokenAccount>,

    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// STATE SCHEMAS
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    pub authority: Pubkey,
    pub verification_oracle: Pubkey,
    pub total_grants_created: u64,
    pub total_disbursed_lamports: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Grant {
    pub grant_id: u64,
    pub sponsor: Pubkey,
    pub recipient: Pubkey,
    pub escrow_vault: Pubkey,
    pub token_mint: Pubkey,
    pub total_amount: u64,
    pub released_amount: u64,
    pub num_milestones: u8,
    pub completed_milestones: u8,
    #[max_len(32)]
    pub destination_event: String,
    pub is_active: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct ProtocolInitializedEvent {
    pub authority: Pubkey,
    pub oracle: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct GrantCreatedEvent {
    pub grant_id: u64,
    pub sponsor: Pubkey,
    pub recipient: Pubkey,
    pub total_amount: u64,
    pub num_milestones: u8,
    pub timestamp: i64,
}

#[event]
pub struct MilestoneSubmittedEvent {
    pub grant_id: u64,
    pub recipient: Pubkey,
    pub milestone_index: u8,
    pub proof_hash: [u8; 32],
    pub timestamp: i64,
}

#[event]
pub struct MilestoneDisbursedEvent {
    pub grant_id: u64,
    pub recipient: Pubkey,
    pub milestone_index: u8,
    pub amount_disbursed: u64,
    pub all_milestones_completed: bool,
    pub timestamp: i64,
}

#[event]
pub struct GrantCancelledEvent {
    pub grant_id: u64,
    pub refund_recipient: Pubkey,
    pub refunded_amount: u64,
    pub timestamp: i64,
}

#[error_code]
pub enum RumboError {
    #[msg("Amount must be greater than zero.")]
    InvalidAmount,
    #[msg("Milestone count must be between 1 and 5.")]
    InvalidMilestoneCount,
    #[msg("String exceeds maximum allowed length.")]
    StringTooLong,
    #[msg("Grant is inactive or already fully disbursed.")]
    GrantInactive,
    #[msg("Signer does not match designated recipient.")]
    UnauthorizedRecipient,
    #[msg("Milestone proof submitted does not match sequential order.")]
    MilestoneSequenceMismatch,
    #[msg("Signer is not authorized oracle or protocol authority.")]
    UnauthorizedOracle,
    #[msg("Math arithmetic overflow occurred.")]
    MathOverflow,
    #[msg("No remaining funds in escrow vault.")]
    NoFundsInEscrow,
}