#![no_std]

//! M2 spike: a settlement contract that receives a CCTP mint itself, instead of handing the
//! mint to Circle's `CctpForwarder`.
//!
//! The contract is the `mintRecipient` and `destinationCaller` on the source burn. It calls
//! `receive_message` on the Stellar `MessageTransmitter`, which mints USDC to this contract,
//! then splits the minted balance between the recipient named in the hook data and a
//! treasury fee. The fee is carried in the optional integrator payload of the hook, so the
//! sender agrees to it in the burn transaction and the contract only enforces the ceiling it
//! was deployed with.
//!
//! This is deliberately small. It exists to answer one question on testnet: can a custom
//! contract replace the forwarder for the mint, parse trailing hook data, and split the
//! tokens atomically. It has no admin surface and nothing to upgrade.

use soroban_sdk::{
    address_payload::AddressPayload, contract, contractclient, contracterror, contractevent,
    contractimpl, contracttype, panic_with_error, token, Address, Bytes, BytesN, Env,
    MuxedAddress,
};

/// The CCTP message header is 148 bytes and the burn body starts immediately after it.
const MESSAGE_BODY_OFFSET: u32 = 148;
/// Within the header, `recipient` is the handler contract, which must be the TokenMessengerMinter.
const HEADER_RECIPIENT_OFFSET: u32 = 76;
/// Within the burn body, `mintRecipient` is the contract that receives the mint.
const BODY_MINT_RECIPIENT_OFFSET: u32 = 36;
/// Within the burn body, any bytes from here on are the hook data.
const BODY_HOOK_DATA_OFFSET: u32 = 228;
const BODY_END_OFFSET: u32 = MESSAGE_BODY_OFFSET + BODY_HOOK_DATA_OFFSET;

const HOOK_VERSION_OFFSET: u32 = 24;
const HOOK_LENGTH_OFFSET: u32 = 28;
const HOOK_RECIPIENT_OFFSET: u32 = 32;
const HOOK_HEADER_LEN: u32 = 32;
const HOOK_VERSION: u32 = 0;
const FEE_PAYLOAD_LEN: u32 = 16;

const BPS_DENOMINATOR: i128 = 10_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum SettlementError {
    MessageTooShort = 1,
    InvalidMessageRecipient = 2,
    InvalidMintRecipient = 3,
    HookDataTooShort = 4,
    InvalidHookVersion = 5,
    InvalidForwardRecipient = 6,
    InvalidFeePayload = 7,
    FeeTooHigh = 8,
    NoTokensMinted = 9,
    InvalidConfig = 10,
}

/// The slice of the Stellar MessageTransmitter this contract needs.
#[contractclient(name = "ReceiverClient")]
pub trait Receiver {
    fn receive_message(e: &Env, caller: Address, message: Bytes, attestation: Bytes) -> bool;
}

#[contracttype]
pub enum DataKey {
    MessageTransmitter,
    TokenMessengerMinter,
    Usdc,
    Treasury,
    MaxFeeBps,
    RelayerBps,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettlementConfig {
    pub message_transmitter: Address,
    pub token_messenger_minter: Address,
    pub usdc: Address,
    pub treasury: Address,
    pub max_fee_bps: u32,
    pub relayer_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettlementReceipt {
    pub recipient: Address,
    pub relayer: Address,
    pub amount: i128,
    pub fee: i128,
    pub relayer_fee: i128,
    pub treasury_fee: i128,
}

#[contractevent(topics = ["settled"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Settled {
    #[topic]
    pub recipient: Address,
    #[topic]
    pub relayer: Address,
    pub amount: i128,
    pub fee: i128,
    pub relayer_fee: i128,
    pub treasury_fee: i128,
}

struct HookData {
    recipient: MuxedAddress,
    fee: i128,
}

#[contract]
pub struct SettlementContract;

#[contractimpl]
impl SettlementContract {
    pub fn __constructor(
        e: Env,
        message_transmitter: Address,
        token_messenger_minter: Address,
        usdc: Address,
        treasury: Address,
        max_fee_bps: u32,
        relayer_bps: u32,
    ) {
        if max_fee_bps > BPS_DENOMINATOR as u32 || relayer_bps > BPS_DENOMINATOR as u32 {
            panic_with_error!(&e, SettlementError::InvalidConfig);
        }
        let instance = e.storage().instance();
        instance.set(&DataKey::MessageTransmitter, &message_transmitter);
        instance.set(&DataKey::TokenMessengerMinter, &token_messenger_minter);
        instance.set(&DataKey::Usdc, &usdc);
        instance.set(&DataKey::Treasury, &treasury);
        instance.set(&DataKey::MaxFeeBps, &max_fee_bps);
        instance.set(&DataKey::RelayerBps, &relayer_bps);
    }

    /// Mints a CCTP message to this contract and splits the result. Permissionless: any
    /// relayer may submit a message, provided the burn named this contract as the
    /// destination caller or left the caller unrestricted.
    pub fn settle(e: Env, relayer: Address, message: Bytes, attestation: Bytes) -> SettlementReceipt {
        relayer.require_auth();

        if message.len() < BODY_END_OFFSET {
            panic_with_error!(&e, SettlementError::MessageTooShort);
        }

        let contract = e.current_contract_address();

        let expected_handler = get_address(&e, DataKey::TokenMessengerMinter);
        let handler_bytes = read_bytes32(&e, &message, HEADER_RECIPIENT_OFFSET);
        let handler = Address::from_payload(&e, AddressPayload::ContractIdHash(handler_bytes));
        if handler != expected_handler {
            panic_with_error!(&e, SettlementError::InvalidMessageRecipient);
        }

        let mint_bytes = read_bytes32(&e, &message, MESSAGE_BODY_OFFSET + BODY_MINT_RECIPIENT_OFFSET);
        let mint_recipient = Address::from_payload(&e, AddressPayload::ContractIdHash(mint_bytes));
        if mint_recipient != contract {
            panic_with_error!(&e, SettlementError::InvalidMintRecipient);
        }

        let hook = message.slice(BODY_END_OFFSET..message.len());
        let parsed = parse_hook(&e, &hook);

        let usdc = get_address(&e, DataKey::Usdc);
        let recipient_address = parsed.recipient.address();
        if recipient_address == usdc || recipient_address == contract {
            panic_with_error!(&e, SettlementError::InvalidForwardRecipient);
        }

        let token_client = token::TokenClient::new(&e, &usdc);
        let before = token_client.balance(&contract);

        let transmitter = get_address(&e, DataKey::MessageTransmitter);
        let receiver = ReceiverClient::new(&e, &transmitter);
        if !receiver.receive_message(&contract, &message, &attestation) {
            panic_with_error!(&e, SettlementError::NoTokensMinted);
        }

        let after = token_client.balance(&contract);
        let amount = after
            .checked_sub(before)
            .unwrap_or_else(|| panic_with_error!(&e, SettlementError::NoTokensMinted));
        if amount <= 0 {
            panic_with_error!(&e, SettlementError::NoTokensMinted);
        }

        let max_fee_bps = get_max_fee_bps(&e);
        let max_fee = amount
            .checked_mul(max_fee_bps)
            .unwrap_or_else(|| panic_with_error!(&e, SettlementError::FeeTooHigh))
            / BPS_DENOMINATOR;
        if parsed.fee > max_fee {
            panic_with_error!(&e, SettlementError::FeeTooHigh);
        }

        let relayer_bps = get_relayer_bps(&e);
        let relayer_fee = parsed
            .fee
            .checked_mul(relayer_bps)
            .unwrap_or_else(|| panic_with_error!(&e, SettlementError::FeeTooHigh))
            / BPS_DENOMINATOR;
        let treasury_fee = parsed.fee - relayer_fee;

        if relayer_fee > 0 {
            let relayer_address: MuxedAddress = relayer.clone().into();
            token_client.transfer(&contract, &relayer_address, &relayer_fee);
        }
        if treasury_fee > 0 {
            let treasury: MuxedAddress = get_address(&e, DataKey::Treasury).into();
            token_client.transfer(&contract, &treasury, &treasury_fee);
        }

        let payout = amount - parsed.fee;
        token_client.transfer(&contract, &parsed.recipient, &payout);

        let receipt = SettlementReceipt {
            recipient: recipient_address,
            relayer: relayer.clone(),
            amount,
            fee: parsed.fee,
            relayer_fee,
            treasury_fee,
        };
        Settled {
            recipient: receipt.recipient.clone(),
            relayer: receipt.relayer.clone(),
            amount: receipt.amount,
            fee: receipt.fee,
            relayer_fee: receipt.relayer_fee,
            treasury_fee: receipt.treasury_fee,
        }
        .publish(&e);
        receipt
    }

    pub fn get_config(e: Env) -> SettlementConfig {
        SettlementConfig {
            message_transmitter: get_address(&e, DataKey::MessageTransmitter),
            token_messenger_minter: get_address(&e, DataKey::TokenMessengerMinter),
            usdc: get_address(&e, DataKey::Usdc),
            treasury: get_address(&e, DataKey::Treasury),
            max_fee_bps: get_max_fee_bps(&e) as u32,
            relayer_bps: get_relayer_bps(&e) as u32,
        }
    }
}

fn get_address(e: &Env, key: DataKey) -> Address {
    e.storage()
        .instance()
        .get(&key)
        .unwrap_or_else(|| panic_with_error!(e, SettlementError::InvalidConfig))
}

fn get_max_fee_bps(e: &Env) -> i128 {
    let stored: u32 = e
        .storage()
        .instance()
        .get(&DataKey::MaxFeeBps)
        .unwrap_or_else(|| panic_with_error!(e, SettlementError::InvalidConfig));
    stored as i128
}

fn get_relayer_bps(e: &Env) -> i128 {
    let stored: u32 = e
        .storage()
        .instance()
        .get(&DataKey::RelayerBps)
        .unwrap_or_else(|| panic_with_error!(e, SettlementError::InvalidConfig));
    stored as i128
}

fn read_u32(bytes: &Bytes, offset: u32) -> Option<u32> {
    let mut buf = [0u8; 4];
    for (index, slot) in buf.iter_mut().enumerate() {
        *slot = bytes.get(offset + index as u32)?;
    }
    Some(u32::from_be_bytes(buf))
}

fn read_bytes32(e: &Env, bytes: &Bytes, offset: u32) -> BytesN<32> {
    let mut buf = [0u8; 32];
    for (index, slot) in buf.iter_mut().enumerate() {
        *slot = bytes
            .get(offset + index as u32)
            .unwrap_or_else(|| panic_with_error!(e, SettlementError::MessageTooShort));
    }
    BytesN::from_array(e, &buf)
}

fn parse_hook(e: &Env, hook: &Bytes) -> HookData {
    if hook.len() < HOOK_HEADER_LEN {
        panic_with_error!(e, SettlementError::HookDataTooShort);
    }
    let version = read_u32(hook, HOOK_VERSION_OFFSET)
        .unwrap_or_else(|| panic_with_error!(e, SettlementError::HookDataTooShort));
    if version != HOOK_VERSION {
        panic_with_error!(e, SettlementError::InvalidHookVersion);
    }
    let recipient_len = read_u32(hook, HOOK_LENGTH_OFFSET)
        .unwrap_or_else(|| panic_with_error!(e, SettlementError::HookDataTooShort));
    let recipient_end = HOOK_RECIPIENT_OFFSET
        .checked_add(recipient_len)
        .unwrap_or_else(|| panic_with_error!(e, SettlementError::HookDataTooShort));
    if hook.len() < recipient_end {
        panic_with_error!(e, SettlementError::HookDataTooShort);
    }

    let strkey = hook.slice(HOOK_RECIPIENT_OFFSET..recipient_end);
    let recipient = MuxedAddress::from_string_bytes(&strkey);

    let trailing = hook.len() - recipient_end;
    let fee = if trailing == 0 {
        0
    } else if trailing == FEE_PAYLOAD_LEN {
        let mut buf = [0u8; 16];
        for (index, slot) in buf.iter_mut().enumerate() {
            *slot = hook
                .get(recipient_end + index as u32)
                .unwrap_or_else(|| panic_with_error!(e, SettlementError::InvalidFeePayload));
        }
        let value = i128::from_be_bytes(buf);
        if value < 0 {
            panic_with_error!(e, SettlementError::InvalidFeePayload);
        }
        value
    } else {
        panic_with_error!(e, SettlementError::InvalidFeePayload);
    };

    HookData { recipient, fee }
}

#[cfg(test)]
mod test;
