// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Subscriptions, ICuratorBondedSubs} from "../src/Subscriptions.sol";

/// Deploys Subscriptions against an existing deployment and records it in ../deployments/<DEPLOY_NAME>.json.
/// Subscriptions is independent of CallRegistry (which stays frozen); it only reads CuratorRegistry.isBonded.
/// env: DEPLOYER_PRIVATE_KEY, DEPLOY_NAME
contract DeploySubscriptions is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        string memory name = vm.envString("DEPLOY_NAME");
        string memory path = string.concat("../deployments/", name, ".json");
        string memory json = vm.readFile(path);
        address curators = vm.parseJsonAddress(json, ".curatorRegistry");
        address token = vm.parseJsonAddress(json, ".bondToken");

        vm.startBroadcast(pk);
        Subscriptions subs = new Subscriptions(IERC20(token), ICuratorBondedSubs(curators));
        vm.stopBroadcast();

        vm.writeJson(vm.toString(address(subs)), path, ".subscriptions");
        console2.log("Subscriptions", address(subs));
    }
}
