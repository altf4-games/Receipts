// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CuratorRegistry} from "../src/CuratorRegistry.sol";
import {CallRegistry, ICuratorBonded} from "../src/CallRegistry.sol";
import {SettlerV1} from "../src/SettlerV1.sol";
import {IPerplExchange} from "../src/interfaces/IPerplExchange.sol";

/// Deploys CuratorRegistry -> CallRegistry -> SettlerV1 and wires them.
/// The settler address is predicted from the deployer nonce so CallRegistry has the right settler from its
/// constructor (no placeholder, no extra rotation event in the history).
///
/// env: DEPLOYER_PRIVATE_KEY, DEPLOY_NAME (e.g. "staging" | "production"), MIN_HORIZON (seconds),
///      EXCHANGE, BOND_TOKEN, MIN_BOND, MAX_ORACLE_AGE
/// Writes ../deployments/<DEPLOY_NAME>.json
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        string memory name = vm.envString("DEPLOY_NAME");
        uint32 minHorizon = uint32(vm.envUint("MIN_HORIZON"));
        uint32 maxOracleAge = uint32(vm.envUint("MAX_ORACLE_AGE"));
        address exchange = vm.envAddress("EXCHANGE");
        address bondToken = vm.envAddress("BOND_TOKEN");
        uint256 minBond = vm.envUint("MIN_BOND");

        uint64 nonce = vm.getNonce(deployer);
        address predictedSettler = vm.computeCreateAddress(deployer, nonce + 2);

        vm.startBroadcast(pk);
        CuratorRegistry curators = new CuratorRegistry(deployer, IERC20(bondToken), minBond);
        CallRegistry registry = new CallRegistry(
            deployer, ICuratorBonded(address(curators)), IPerplExchange(exchange), predictedSettler, minHorizon, maxOracleAge
        );
        SettlerV1 settler = new SettlerV1(registry, IPerplExchange(exchange), maxOracleAge);
        require(address(settler) == predictedSettler, "settler address prediction failed");
        curators.setCallRegistry(address(registry));
        uint256[5] memory markets = [uint256(16), 32, 48, 64, 256]; // BTC ETH SOL MON ZEC (Perpl testnet ids)
        for (uint256 i = 0; i < markets.length; i++) registry.setMarketAllowed(markets[i], true);
        vm.stopBroadcast();

        _write(name, deployer, address(curators), address(registry), address(settler));

        console2.log("CuratorRegistry", address(curators));
        console2.log("CallRegistry   ", address(registry));
        console2.log("SettlerV1      ", address(settler));
    }

    function _write(string memory name, address deployer, address curators, address registry, address settler) internal {
        string memory o = "d";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeString(o, "name", name);
        vm.serializeAddress(o, "deployer", deployer);
        vm.serializeAddress(o, "exchange", vm.envAddress("EXCHANGE"));
        vm.serializeAddress(o, "bondToken", vm.envAddress("BOND_TOKEN"));
        vm.serializeUint(o, "minBond", vm.envUint("MIN_BOND"));
        vm.serializeUint(o, "minHorizon", vm.envUint("MIN_HORIZON"));
        vm.serializeUint(o, "maxOracleAge", vm.envUint("MAX_ORACLE_AGE"));
        vm.serializeAddress(o, "curatorRegistry", curators);
        vm.serializeAddress(o, "callRegistry", registry);
        string memory out = vm.serializeAddress(o, "settlerV1", settler);
        vm.writeJson(out, string.concat("../deployments/", name, ".json"));
    }
}
