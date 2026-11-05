# Clean and compile the Rust Anchor binary
anchor build

# Retrieve generated Program ID and replace in lib.rs if modified
solana address -k target/deploy/rumbo_escrow-keypair.json