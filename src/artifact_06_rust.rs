use anchor_lang::prelude::*;

#[error_code]
pub enum RumboError {
    #[msg("Campaign deadline has already passed.")]
    CampaignExpired,
    #[msg("Campaign has insufficient balance for this allocation.")]
    InsufficientCampaignVaultFunds,
    #[msg("Grantee is not yet verified for payout.")]
    GranteeNotVerified,
    #[msg("All milestones have not yet been approved.")]
    MilestonesPending,
    #[msg("Grantee has already claimed the allocated stipend.")]
    AlreadyClaimed,
    #[msg("Campaign is currently active; refund cannot be initiated.")]
    CampaignStillActive,
    #[msg("Unauthorized review authority.")]
    UnauthorizedReviewer,
    #[msg("Numerical overflow occurred in calculations.")]
    MathOverflow,
    #[msg("Strings exceeds maximum permissible length.")]
    InputStringTooLong,
}