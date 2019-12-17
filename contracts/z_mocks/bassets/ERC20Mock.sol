pragma solidity ^0.5.12;

import "openzeppelin-solidity/contracts/token/ERC20/ERC20Detailed.sol";
import "openzeppelin-solidity/contracts/token/ERC20/ERC20.sol";

contract ERC20Mock is ERC20, ERC20Detailed {
    constructor (
        string memory _name,
        string memory _symbol,
        uint8 _decimals,
        address _initialRecipient,
        uint256 _initialMint
    )
        ERC20Detailed
    (
        _name,
        _symbol,
        _decimals
    )
        public
    {
        _mint(_initialRecipient, _initialMint);
    }
}

