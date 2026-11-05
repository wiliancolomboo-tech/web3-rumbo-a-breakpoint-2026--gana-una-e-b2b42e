use anchor_lang::prelude::*;

#[account]
pub struct ProgramConfig {
    pub admin: Pubkey,
    pub reviewer_oracle: Pubkey,
    pub event_checkin_authority: Pubkey,
    pub total_allocated: u64,
    pub total_disbursed: u64,
    pub bump: u8,
}

impl ProgramConfig {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 8 + 8 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum GrantStage {
    Submitted,
    Funded,
    MilestoneVerified, // 50% disbursed (Flight & accommodation support)
    AttendedAndSettled, // 100% disbursed (On-site check-in complete)
    ClawedBack,
}

#[account]
pub struct GrantApplication {
    pub grantee: Pubkey,
    pub repo_commit_hash: [u8; 32],
    pub grant_amount: u64,
    pub disbursed_amount: u64,
    pub deadline_timestamp: i64,
    pub stage: GrantStage,
    pub metadata_uri: String, // Max 128 chars IPFS/Arweave link
    pub bump: u8,
    pub vault_bump: u8,
}

impl GrantApplication {
    pub const MAX_METADATA_LEN: usize = 128;
    pub const LEN: usize = 8 + // discriminator
        32 + // grantee
        32 + // repo_commit_hash
        8  + // grant_amount
        8  + // disbursed_amount
        8  + // deadline_timestamp
        1  + // stage enum
        (4 + Self::MAX_METADATA_LEN) + // string
        1  + // bump
        1;   // vault_bump
}