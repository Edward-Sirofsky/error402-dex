// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice One-for-one wrapper of native test SYS for testnet AMM pools.
contract WrappedTestSYS {
    string public constant name = "Wrapped Test SYS";
    string public constant symbol = "WTSYS";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);
    receive() external payable { deposit(); }
    function totalSupply() external view returns (uint256) { return address(this).balance; }
    function deposit() public payable { balanceOf[msg.sender] += msg.value; emit Deposit(msg.sender, msg.value); emit Transfer(address(0), msg.sender, msg.value); }
    function withdraw(uint256 value) external {
        require(balanceOf[msg.sender] >= value, "BALANCE");
        balanceOf[msg.sender] -= value;
        emit Withdrawal(msg.sender, value); emit Transfer(msg.sender, address(0), value);
        (bool ok,) = msg.sender.call{value:value}(""); require(ok, "SEND_FAILED");
    }
    function approve(address spender, uint256 value) external returns (bool) { allowance[msg.sender][spender] = value; emit Approval(msg.sender, spender, value); return true; }
    function transfer(address to, uint256 value) external returns (bool) { return transferFrom(msg.sender, to, value); }
    function transferFrom(address from, address to, uint256 value) public returns (bool) {
        require(to != address(0), "ZERO_ADDRESS"); require(balanceOf[from] >= value, "BALANCE");
        if (from != msg.sender && allowance[from][msg.sender] != type(uint256).max) {
            require(allowance[from][msg.sender] >= value, "ALLOWANCE"); allowance[from][msg.sender] -= value;
        }
        balanceOf[from] -= value; balanceOf[to] += value; emit Transfer(from, to, value); return true;
    }
}
