import json
with open('c:\\Users\\DEVAN\\Desktop\\Decentralized-Voting-System-main\\build\\contracts\\Voting.json') as f:
    voting = json.load(f)
    networks = voting.get('networks', {})
    for network_id, data in networks.items():
        print(f'Network ID: {network_id}')
        print(f'Address: {data.get("address", "N/A")}')
