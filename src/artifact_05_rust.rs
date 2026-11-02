use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Campaign {
    pub authority: Pubkey,            // 32
    pub token_mint: Pubkey,           // 32
    pub vault: Pubkey,                // 32
    pub total_allocation: u64,        // 8
    pub disbursed_amount: u64,        // 8
    pub stipend_per_scholar: u64,     // 8
    pub total_grantees: u32,          // 4
    pub approved_grantees: u32,       // 4
    pub deadline: i64,                // 8
    pub bump: u8,                     // 1
    pub vault_bump: u8,               // 1
    #[max_len(64)]
    pub title: String,                // 4 + 64
}

#[account]
#[derive(InitSpace)]
pub struct Grantee {
    pub campaign: Pubkey,             // 32
    pub scholar: Pubkey,              // 32
    pub stipend_amount: u64,          // 8
    pub milestone_count: u8,          // 1
    pub milestones_approved: u8,      // 1
    pub status: GranteeStatus,        // 1
    pub ticket_issued: bool,          // 1
    pub funds_claimed: bool,          // 1
    pub bump: u8,                     // 1
    #[max_len(64)]
    pub repo_commit_hash: String,     // 4 + 64
    #[max_len(32)]
    pub handle: String,               // 4 + 32
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum GranteeStatus {
    Applied,
    Verified,
    Funded,
    Completed,
    Rejected,
}