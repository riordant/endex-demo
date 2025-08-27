---
title: Aggregator
sidebar_position: 3
---

# Aggregator

| Aspect | Description |
|---------|-------------|
| **Type** | Intermediary service between the blockchain and computation layer, ensuring structured request management. |
| **Function** | Manages and organizes the events (requests) received from the Task Manager Contract to ensure efficient processing. |
| **Responsibilities** | • Listens to the emitted events on the destination chain<br/>• Processes incoming requests in FIFO (First In, First Out) to ensure fairness and consistency<br/>• Prepares and structures the data/events and submits the request to the fheOS server<br/>• Receives the results from the fheOS server and sends it to the Data Availability layer<br/>• Upon decryption result, submits the result to the host chain |

