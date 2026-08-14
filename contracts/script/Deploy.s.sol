// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {SealedCaller} from "../src/SealedCaller.sol";

/// Deploy with:  forge script script/Deploy.s.sol --rpc-url $RPC --broadcast
/// Network is selected by TARGET=testnet|mainnet (default testnet).
contract Deploy is Script {
    // Base Sepolia (84532) — from llms.megapot.io/contracts/reference
    address constant T_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address constant T_JACKPOT = 0x465dA3c859f193A3807386387bEE941B2A4c3279;
    // Base mainnet (8453)
    address constant M_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant M_JACKPOT = 0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2;
    address constant M_RANDOM_BUYER = 0xb9560b43b91dE2c1DaF5dfbb76b2CFcDaFc13aBd;
    address constant T_RANDOM_BUYER = 0x53c04e7e5044B28Ea8A4F9c4b26E3Ac1aeb63746;

    function run() external {
        bool mainnet = keccak256(bytes(vm.envOr("TARGET", string("testnet")))) == keccak256("mainnet");
        address randomBuyer = mainnet ? M_RANDOM_BUYER : T_RANDOM_BUYER;
        address treasury = vm.envAddress("TREASURY");
        vm.startBroadcast();
        new SealedCaller(
            mainnet ? M_USDC : T_USDC,
            mainnet ? M_JACKPOT : T_JACKPOT,
            randomBuyer,
            treasury
        );
        vm.stopBroadcast();
    }
}
