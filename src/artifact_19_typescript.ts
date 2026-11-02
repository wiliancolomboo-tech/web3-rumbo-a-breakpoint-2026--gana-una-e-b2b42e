import { Command } from "commander";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as crypto from "crypto";
import * as fs from "fs";

const program = new Command();
const PROGRAM_ID = new PublicKey("Rumbok2j6pT8WwzGk4n4YqH2vF5aQ9S1zX3kM7mN8bV");

program
  .name("rumbo-cli")
  .description("CLI for Rumbo a Breakpoint 2026 Grant Automation")
  .version("1.0.0");

program
  .command("hash-ticket")
  .description("Generate sha256 hash for ticket verification claim")
  .argument("<ticketNumber>", "Unique ticket confirmation code")
  .action((ticketNumber: string) => {
    const hash = crypto.createHash("sha256").update(ticketNumber).digest();
    console.log(`Ticket Code: ${ticketNumber}`);
    console.log(`Hash (Hex): ${hash.toString("hex")}`);
    console.log(`Hash (Byte Array): [${Array.from(hash).join(", ")}]`);
  });

program
  .command("hash-attendance")
  .description("Generate Breakpoint 2026 on-site attendance proof hash")
  .argument("<badgeId>", "Attendee NFC or Badge ID")
  .argument("<secretSalt>", "Curator signature salt")
  .action((badgeId: string, secretSalt: string) => {
    const raw = `${badgeId}:${secretSalt}`;
    const hash = crypto.createHash("sha256").update(raw).digest();
    console.log(`Badge attendance input: ${raw}`);
    console.log(`Attestation Hash: [${Array.from(hash).join(", ")}]`);
  });

program.parse(process.argv);