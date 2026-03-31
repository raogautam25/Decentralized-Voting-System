// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Voting {
    struct Candidate {
        uint256 id;
        string name;
        string party;
        uint256 voteCount;
    }

    mapping(uint256 => Candidate) public candidates;
    mapping(uint256 => bool) private candidateExists;
    mapping(address => bool) public voters;
    mapping(bytes32 => bool) public votedQrTokens;

    uint256 public countCandidates;
    uint256 public votingStart;
    uint256 public votingEnd;
    address public owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event CandidateAdded(uint256 indexed id, string name, string party);
    event Voted(address indexed voter, uint256 indexed candidateId);
    event VotedByQr(address indexed operator, uint256 indexed candidateId, bytes32 indexed qrHash);
    event VoteCast(address indexed voter, uint256 indexed candidateId, uint256 timestamp);
    event DatesSet(uint256 start, uint256 end);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner can perform this action");
        _;
    }

    modifier validCandidate(uint256 candidateID) {
        require(candidateID > 0 && candidateID <= countCandidates, "Invalid candidate");
        require(candidateExists[candidateID], "Candidate does not exist");
        _;
    }

    modifier withinVotingWindow() {
        require(votingStart != 0 && votingEnd != 0, "Voting dates not set");
        require(block.timestamp >= votingStart, "Voting has not started");
        require(block.timestamp < votingEnd, "Voting has ended");
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), owner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "New owner cannot be zero address");
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addCandidate(string memory name, string memory party) public onlyOwner returns (uint256) {
        require(bytes(name).length > 0, "Name required");
        require(bytes(party).length > 0, "Party required");

        countCandidates += 1;
        candidates[countCandidates] = Candidate({
            id: countCandidates,
            name: name,
            party: party,
            voteCount: 0
        });
        candidateExists[countCandidates] = true;

        emit CandidateAdded(countCandidates, name, party);
        return countCandidates;
    }

    function vote(uint256 candidateID) public withinVotingWindow validCandidate(candidateID) {
        require(!voters[msg.sender], "Already voted");

        voters[msg.sender] = true;
        candidates[candidateID].voteCount += 1;

        emit Voted(msg.sender, candidateID);
        emit VoteCast(msg.sender, candidateID, block.timestamp);
    }

    function voteByQr(uint256 candidateID, string memory qrToken) public withinVotingWindow validCandidate(candidateID) {
        require(bytes(qrToken).length > 0, "QR token required");

        bytes32 qrHash = keccak256(abi.encodePacked(qrToken));
        require(!votedQrTokens[qrHash], "QR already voted");

        votedQrTokens[qrHash] = true;
        candidates[candidateID].voteCount += 1;

        emit VotedByQr(msg.sender, candidateID, qrHash);
        emit VoteCast(msg.sender, candidateID, block.timestamp);
    }

    function checkVote() public view returns (bool) {
        return voters[msg.sender];
    }

    function checkVoteByQr(string memory qrToken) public view returns (bool) {
        if (bytes(qrToken).length == 0) {
            return false;
        }
        bytes32 qrHash = keccak256(abi.encodePacked(qrToken));
        return votedQrTokens[qrHash];
    }

    function getCountCandidates() public view returns (uint256) {
        return countCandidates;
    }

    function getCandidate(uint256 candidateID)
        public
        view
        validCandidate(candidateID)
        returns (uint256, string memory, string memory, uint256)
    {
        Candidate memory candidate = candidates[candidateID];
        return (candidate.id, candidate.name, candidate.party, candidate.voteCount);
    }

    function setDates(uint256 startDate, uint256 endDate) public onlyOwner {
        require(endDate > startDate, "End must be after start");
        votingStart = startDate;
        votingEnd = endDate;
        emit DatesSet(votingStart, votingEnd);
    }

    function getDates() public view returns (uint256, uint256) {
        return (votingStart, votingEnd);
    }
}
