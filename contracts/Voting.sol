pragma solidity ^0.5.15;

contract Voting {
    struct Candidate {
        uint id;
        string name;
        string party; 
        uint voteCount;
    }

    mapping (uint => Candidate) public candidates;
    mapping (address => bool) public voters;
    mapping (bytes32 => bool) public votedQrTokens;

    uint public countCandidates;
    uint256 public votingEnd;
    uint256 public votingStart;

    // Helpful events for debugging/UX
    event CandidateAdded(uint indexed id, string name, string party);
    event Voted(address indexed voter, uint indexed candidateId);
    event VotedByQr(address indexed operator, uint indexed candidateId, bytes32 indexed qrHash);
    event DatesSet(uint256 start, uint256 end);

    function addCandidate(string memory name, string memory party) public returns (uint) {
        require(bytes(name).length > 0, "Name required");
        require(bytes(party).length > 0, "Party required");

        countCandidates++;
        candidates[countCandidates] = Candidate(countCandidates, name, party, 0);

        emit CandidateAdded(countCandidates, name, party);
        return countCandidates;
    }
   
    function vote(uint candidateID) public {
        // must be within window
        require(votingStart != 0 && votingEnd != 0, "Voting dates not set");
        require(block.timestamp >= votingStart, "Voting has not started");
        require(block.timestamp < votingEnd, "Voting has ended");

        // candidate must exist (IDs are 1..countCandidates)
        require(candidateID > 0 && candidateID <= countCandidates, "Invalid candidate");

        // must not have voted already
        require(!voters[msg.sender], "Already voted");
              
        voters[msg.sender] = true;
        candidates[candidateID].voteCount++;

        emit Voted(msg.sender, candidateID);
    }
    
    function checkVote() public view returns (bool) {
        return voters[msg.sender];
    }

    function voteByQr(uint candidateID, string memory qrToken) public {
        // must be within window
        require(votingStart != 0 && votingEnd != 0, "Voting dates not set");
        require(block.timestamp >= votingStart, "Voting has not started");
        require(block.timestamp < votingEnd, "Voting has ended");

        // candidate must exist
        require(candidateID > 0 && candidateID <= countCandidates, "Invalid candidate");

        require(bytes(qrToken).length > 0, "QR token required");
        bytes32 qrHash = keccak256(abi.encodePacked(qrToken));
        require(!votedQrTokens[qrHash], "QR already voted");

        votedQrTokens[qrHash] = true;
        candidates[candidateID].voteCount++;

        emit VotedByQr(msg.sender, candidateID, qrHash);
    }

    function checkVoteByQr(string memory qrToken) public view returns (bool) {
        if (bytes(qrToken).length == 0) {
            return false;
        }
        bytes32 qrHash = keccak256(abi.encodePacked(qrToken));
        return votedQrTokens[qrHash];
    }
       
    function getCountCandidates() public view returns (uint) {
        return countCandidates;
    }

    function getCandidate(uint candidateID)
        public
        view
        returns (uint, string memory, string memory, uint)
    {
        return (
            candidateID,
            candidates[candidateID].name,
            candidates[candidateID].party,
            candidates[candidateID].voteCount
        );
    }

    

    function setDates(uint256 _startDate, uint256 _endDate) public {
        require(_endDate > _startDate, "End must be after start");
        // Allow updating dates for new elections without requiring contract redeploy.
        votingStart = _startDate;
        votingEnd = _endDate;

        emit DatesSet(votingStart, votingEnd);
    }

    function getDates() public view returns (uint256, uint256) {
            return (votingStart, votingEnd);
        }

    
}
