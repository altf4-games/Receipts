// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {CallRegistry} from "../src/CallRegistry.sol";
import {PriceTape} from "../src/PriceTape.sol";
import {SettlerV2} from "../src/SettlerV2.sol";
import {IPerplExchange} from "../src/interfaces/IPerplExchange.sol";

/// Deploys PriceTape + SettlerV2 next to an existing deployment (reads ../deployments/<DEPLOY_NAME>.json) and records them.
/// It does NOT rotate the registry's settler: that is a separate, timelocked owner action (proposeSettler / activateSettler).
/// env: DEPLOYER_PRIVATE_KEY, DEPLOY_NAME, FORWARDER (CRE forwarder: MockKeystoneForwarder in simulation), DISPUTE_WINDOW (seconds)
contract DeployV2 is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        string memory name = vm.envString("DEPLOY_NAME");
        address forwarder = vm.envAddress("FORWARDER");
        uint32 window = uint32(vm.envUint("DISPUTE_WINDOW"));
        string memory path = string.concat("../deployments/", name, ".json");
        string memory json = vm.readFile(path);
        address registry = vm.parseJsonAddress(json, ".callRegistry");
        address exchange = vm.parseJsonAddress(json, ".exchange");
        uint32 maxAge = uint32(vm.parseJsonUint(json, ".maxOracleAge"));

        vm.startBroadcast(pk);
        PriceTape tape = new PriceTape(IPerplExchange(exchange), maxAge, forwarder);
        SettlerV2 v2 = new SettlerV2(CallRegistry(registry), tape, window, forwarder);
        vm.stopBroadcast();

        vm.writeJson(vm.toString(address(tape)), path, ".priceTape");
        vm.writeJson(vm.toString(address(v2)), path, ".settlerV2");
        vm.writeJson(vm.toString(forwarder), path, ".creForwarder");
        vm.writeJson(vm.toString(uint256(window)), path, ".disputeWindow");
        console2.log("PriceTape", address(tape));
        console2.log("SettlerV2", address(v2));
    }
}
