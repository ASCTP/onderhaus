use crate::{SettlementContract, SettlementContractClient, SettlementError};
use soroban_sdk::{
    address_payload::AddressPayload, contract, contractimpl, testutils::Address as _, token,
    Address, Bytes, BytesN, Env,
};

fn assert_contract_error(
    result: Result<
        Result<crate::SettlementReceipt, soroban_sdk::ConversionError>,
        Result<soroban_sdk::Error, soroban_sdk::InvokeError>,
    >,
    expected: SettlementError,
) {
    assert_eq!(
        result.unwrap_err().unwrap(),
        soroban_sdk::Error::from_contract_error(expected as u32)
    );
}

#[contract]
pub struct MockMessageTransmitter;

#[contractimpl]
impl MockMessageTransmitter {
    pub fn set(e: &Env, token: Address, amount: i128) {
        e.storage().instance().set(&"token", &token);
        e.storage().instance().set(&"amount", &amount);
    }

    pub fn receive_message(e: &Env, caller: Address, _message: Bytes, _attestation: Bytes) -> bool {
        caller.require_auth();
        let token: Address = e.storage().instance().get(&"token").unwrap();
        let amount: i128 = e.storage().instance().get(&"amount").unwrap();
        token::StellarAssetClient::new(e, &token)
            .mock_all_auths()
            .mint(&caller, &amount);
        true
    }
}

#[contract]
pub struct MockHandler;

#[contractimpl]
impl MockHandler {
    pub fn ping() {}
}

struct Setup {
    env: Env,
    settlement: Address,
    token: Address,
    treasury: Address,
    recipient: Address,
    relayer: Address,
    handler: Address,
}

fn setup(mint_amount: i128, max_fee_bps: u32) -> Setup {
    setup_with_relayer_bps(mint_amount, max_fee_bps, 7_000)
}

fn setup_with_relayer_bps(mint_amount: i128, max_fee_bps: u32, relayer_bps: u32) -> Setup {
    let env = Env::default();
    env.mock_all_auths();

    let token_admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(token_admin).address();

    let transmitter = env.register(MockMessageTransmitter, ());
    MockMessageTransmitterClient::new(&env, &transmitter).set(&token, &mint_amount);

    let handler = env.register(MockHandler, ());
    let treasury = env.register(MockHandler, ());
    let recipient = env.register(MockHandler, ());
    let relayer = env.register(MockHandler, ());

    let settlement = env.register(
        SettlementContract,
        (
            transmitter.clone(),
            handler.clone(),
            token.clone(),
            treasury.clone(),
            max_fee_bps,
            relayer_bps,
        ),
    );

    Setup {
        env,
        settlement,
        token,
        treasury,
        recipient,
        relayer,
        handler,
    }
}

fn address_bytes32(address: &Address) -> BytesN<32> {
    match address.to_payload() {
        Some(AddressPayload::ContractIdHash(bytes)) => bytes,
        _ => panic!("expected a contract address"),
    }
}

fn build_hook(e: &Env, recipient: &Address, fee: Option<i128>) -> Bytes {
    let strkey = recipient.to_string().to_bytes();
    let mut hook = Bytes::new(e);
    hook.extend_from_array(&[0u8; 24]);
    hook.extend_from_array(&0u32.to_be_bytes());
    hook.extend_from_array(&strkey.len().to_be_bytes());
    hook.append(&strkey);
    if let Some(fee) = fee {
        hook.extend_from_array(&fee.to_be_bytes());
    }
    hook
}

fn build_message(e: &Env, handler: &Address, mint_recipient: &Address, hook: &Bytes) -> Bytes {
    let zero = [0u8; 32];
    let mut message = Bytes::new(e);
    // Header
    message.extend_from_array(&1u32.to_be_bytes());
    message.extend_from_array(&26u32.to_be_bytes());
    message.extend_from_array(&27u32.to_be_bytes());
    message.extend_from_array(&[7u8; 32]); // nonce
    message.extend_from_array(&zero); // sender
    message.extend_from_array(&address_bytes32(handler).to_array()); // recipient
    message.extend_from_array(&zero); // destination caller
    message.extend_from_array(&2000u32.to_be_bytes());
    message.extend_from_array(&2000u32.to_be_bytes());
    // Burn body
    message.extend_from_array(&1u32.to_be_bytes());
    message.extend_from_array(&zero); // burn token
    message.extend_from_array(&address_bytes32(mint_recipient).to_array());
    message.extend_from_array(&zero); // amount
    message.extend_from_array(&zero); // message sender
    message.extend_from_array(&zero); // max fee
    message.extend_from_array(&zero); // fee executed
    message.extend_from_array(&zero); // expiration
    message.append(hook);
    message
}

fn balance(s: &Setup, address: &Address) -> i128 {
    token::TokenClient::new(&s.env, &s.token).balance(address)
}

#[test]
fn settles_and_splits_the_minted_amount() {
    let s = setup(1_000, 500);
    let hook = build_hook(&s.env, &s.recipient, Some(50));
    let message = build_message(&s.env, &s.handler, &s.settlement, &hook);

    let receipt = SettlementContractClient::new(&s.env, &s.settlement)
        .settle(&s.relayer, &message, &Bytes::new(&s.env));

    assert_eq!(receipt.amount, 1_000);
    assert_eq!(receipt.fee, 50);
    assert_eq!(receipt.relayer, s.relayer);
    assert_eq!(receipt.source_domain, 26);
    assert_eq!(receipt.nonce, BytesN::from_array(&s.env, &[7u8; 32]));
    assert_eq!(receipt.relayer_fee, 35);
    assert_eq!(receipt.treasury_fee, 15);
    assert_eq!(balance(&s, &s.recipient), 950);
    assert_eq!(balance(&s, &s.relayer), 35);
    assert_eq!(balance(&s, &s.treasury), 15);
    assert_eq!(balance(&s, &s.settlement), 0);
}

#[test]
fn sends_the_whole_fee_to_the_relayer_at_full_relayer_bps() {
    let s = setup_with_relayer_bps(1_000, 500, 10_000);
    let hook = build_hook(&s.env, &s.recipient, Some(50));
    let message = build_message(&s.env, &s.handler, &s.settlement, &hook);

    let receipt = SettlementContractClient::new(&s.env, &s.settlement)
        .settle(&s.relayer, &message, &Bytes::new(&s.env));

    assert_eq!(receipt.relayer_fee, 50);
    assert_eq!(receipt.treasury_fee, 0);
    assert_eq!(balance(&s, &s.relayer), 50);
    assert_eq!(balance(&s, &s.treasury), 0);
}

#[test]
fn sends_the_whole_fee_to_the_treasury_at_zero_relayer_bps() {
    let s = setup_with_relayer_bps(1_000, 500, 0);
    let hook = build_hook(&s.env, &s.recipient, Some(50));
    let message = build_message(&s.env, &s.handler, &s.settlement, &hook);

    let receipt = SettlementContractClient::new(&s.env, &s.settlement)
        .settle(&s.relayer, &message, &Bytes::new(&s.env));

    assert_eq!(receipt.relayer_fee, 0);
    assert_eq!(receipt.treasury_fee, 50);
    assert_eq!(balance(&s, &s.relayer), 0);
    assert_eq!(balance(&s, &s.treasury), 50);
}

#[test]
fn rounds_the_relayer_share_down() {
    let s = setup_with_relayer_bps(1_000, 500, 7_000);
    let hook = build_hook(&s.env, &s.recipient, Some(1));
    let message = build_message(&s.env, &s.handler, &s.settlement, &hook);

    let receipt = SettlementContractClient::new(&s.env, &s.settlement)
        .settle(&s.relayer, &message, &Bytes::new(&s.env));

    assert_eq!(receipt.relayer_fee, 0);
    assert_eq!(receipt.treasury_fee, 1);
}

#[test]
#[should_panic(expected = "Error(Contract, #10)")]
fn rejects_a_relayer_share_above_the_denominator() {
    setup_with_relayer_bps(1_000, 100, 10_001);
}

#[test]
fn settles_without_a_fee_payload() {
    let s = setup(1_000, 100);
    let hook = build_hook(&s.env, &s.recipient, None);
    let message = build_message(&s.env, &s.handler, &s.settlement, &hook);

    let receipt = SettlementContractClient::new(&s.env, &s.settlement)
        .settle(&s.relayer, &message, &Bytes::new(&s.env));

    assert_eq!(receipt.fee, 0);
    assert_eq!(balance(&s, &s.recipient), 1_000);
    assert_eq!(balance(&s, &s.treasury), 0);
}

#[test]
fn rejects_a_fee_above_the_configured_ceiling() {
    let s = setup(1_000, 100);
    let hook = build_hook(&s.env, &s.recipient, Some(101));
    let message = build_message(&s.env, &s.handler, &s.settlement, &hook);

    let result = SettlementContractClient::new(&s.env, &s.settlement)
        .try_settle(&s.relayer, &message, &Bytes::new(&s.env));

    assert_contract_error(result, SettlementError::FeeTooHigh);
}

#[test]
fn rejects_a_message_minted_to_another_contract() {
    let s = setup(1_000, 100);
    let hook = build_hook(&s.env, &s.recipient, None);
    let message = build_message(&s.env, &s.handler, &s.treasury, &hook);

    let result = SettlementContractClient::new(&s.env, &s.settlement)
        .try_settle(&s.relayer, &message, &Bytes::new(&s.env));

    assert_contract_error(result, SettlementError::InvalidMintRecipient);
}

#[test]
fn rejects_a_message_for_another_handler() {
    let s = setup(1_000, 100);
    let hook = build_hook(&s.env, &s.recipient, None);
    let message = build_message(&s.env, &s.treasury, &s.settlement, &hook);

    let result = SettlementContractClient::new(&s.env, &s.settlement)
        .try_settle(&s.relayer, &message, &Bytes::new(&s.env));

    assert_contract_error(result, SettlementError::InvalidMessageRecipient);
}

#[test]
fn rejects_a_hook_that_is_too_short() {
    let s = setup(1_000, 100);
    let message = build_message(&s.env, &s.handler, &s.settlement, &Bytes::new(&s.env));

    let result = SettlementContractClient::new(&s.env, &s.settlement)
        .try_settle(&s.relayer, &message, &Bytes::new(&s.env));

    assert_contract_error(result, SettlementError::HookDataTooShort);
}

#[test]
fn rejects_a_trailing_payload_that_is_not_a_fee() {
    let s = setup(1_000, 100);
    let mut hook = build_hook(&s.env, &s.recipient, None);
    hook.extend_from_array(&[1u8, 2, 3]);
    let message = build_message(&s.env, &s.handler, &s.settlement, &hook);

    let result = SettlementContractClient::new(&s.env, &s.settlement)
        .try_settle(&s.relayer, &message, &Bytes::new(&s.env));

    assert_contract_error(result, SettlementError::InvalidFeePayload);
}

#[test]
fn rejects_an_unsupported_hook_version() {
    let s = setup(1_000, 100);
    let strkey = s.recipient.to_string().to_bytes();
    let mut hook = Bytes::new(&s.env);
    hook.extend_from_array(&[0u8; 24]);
    hook.extend_from_array(&1u32.to_be_bytes());
    hook.extend_from_array(&strkey.len().to_be_bytes());
    hook.append(&strkey);
    let message = build_message(&s.env, &s.handler, &s.settlement, &hook);

    let result = SettlementContractClient::new(&s.env, &s.settlement)
        .try_settle(&s.relayer, &message, &Bytes::new(&s.env));

    assert_contract_error(result, SettlementError::InvalidHookVersion);
}

#[test]
fn rejects_a_message_shorter_than_the_burn_body() {
    let s = setup(1_000, 100);
    let short = Bytes::from_slice(&s.env, &[0u8; 100]);

    let result = SettlementContractClient::new(&s.env, &s.settlement)
        .try_settle(&s.relayer, &short, &Bytes::new(&s.env));

    assert_contract_error(result, SettlementError::MessageTooShort);
}

#[test]
fn rejects_a_zero_mint() {
    let s = setup(0, 100);
    let hook = build_hook(&s.env, &s.recipient, None);
    let message = build_message(&s.env, &s.handler, &s.settlement, &hook);

    let result = SettlementContractClient::new(&s.env, &s.settlement)
        .try_settle(&s.relayer, &message, &Bytes::new(&s.env));

    assert_contract_error(result, SettlementError::NoTokensMinted);
}

#[test]
fn rejects_a_forward_recipient_that_is_the_usdc_contract() {
    let s = setup(1_000, 100);
    let hook = build_hook(&s.env, &s.token, None);
    let message = build_message(&s.env, &s.handler, &s.settlement, &hook);

    let result = SettlementContractClient::new(&s.env, &s.settlement)
        .try_settle(&s.relayer, &message, &Bytes::new(&s.env));

    assert_contract_error(result, SettlementError::InvalidForwardRecipient);
}

#[test]
fn exposes_its_configuration() {
    let s = setup(1_000, 250);
    let config = SettlementContractClient::new(&s.env, &s.settlement).get_config();

    assert_eq!(config.token_messenger_minter, s.handler);
    assert_eq!(config.usdc, s.token);
    assert_eq!(config.treasury, s.treasury);
    assert_eq!(config.max_fee_bps, 250);
    assert_eq!(config.relayer_bps, 7_000);
}
