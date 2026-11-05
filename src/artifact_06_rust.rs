use anchor_lang::prelude::*;

#[error_code]
pub enum BreakpointError {
    #[msg("Invalid authority signature for this operation.")]
    Unauthorized,
    #[msg("Invalid status transition for grant escrow.")]
    InvalidStageTransition,
    #[msg("Milestone deadline has passed. Grant is subject to clawback.")]
    GrantExpired,
    #[msg("Milestone deadline has not yet expired.")]
    GrantNotExpired,
    #[msg("Metadata URI exceeds maximum permissible length (128 bytes).")]
    MetadataTooLong,
    #[msg("Numerical overflow during arithmetic operation.")]
    MathOverflow,
    #[msg("Invalid check-in signature for Breakpoint 2026 venue.")]
    InvalidCheckinSignature,
}