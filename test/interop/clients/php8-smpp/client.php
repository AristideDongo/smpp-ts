<?php
/**
 * php8-smpp client (fork of onlinecity/php-smpp) for the smpp-ts server interop suite.
 *
 *     composer install -d test/interop/clients/php8-smpp
 *     php test/interop/clients/php8-smpp/client.php <host> <port>
 *
 * Binds as transceiver, sends a short GSM7 message and a long UCS2 one (split by php8-smpp itself,
 * 8-bit UDH), asks for receipts, waits for them and for one MO, unbinds, and prints a JSON summary on
 * the last line.
 */

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use Smpp\Client;
use Smpp\ClientBuilder;
use Smpp\Configs\SmppConfig;
use Smpp\Pdu\Address;
use Smpp\Pdu\Pdu;
use Smpp\Pdu\Sms;
use Smpp\Protocol\Command;
use Smpp\Protocol\CommandStatus;
use Smpp\Smpp;

$expected = json_decode((string)file_get_contents(__DIR__ . '/../expected.json'), true, 512, JSON_THROW_ON_ERROR);
[, $host, $port] = $argv;

/**
 * Works around three php8-smpp 0.1.1 behaviours (documented in test/interop/README.md):
 * - sendSMS() returns only the last segment's message id: every submit_sm_resp id is recorded;
 * - DeliveryReceipt::$id is typed int under strict_types, so no receipt can be parsed: the receipt id
 *   is read from the receipt text;
 * - with 8-bit UDH, the concatenation reference is taken again for each segment (it increments) and
 *   only its second decimal digit is written: segments of one message may carry different references.
 *   The reference is held constant while one message is sent.
 */
final class InteropClient extends Client
{
    /** @var string[] */
    public array $submitted = [];
    /** @var string[] */
    public array $receipts = [];
    /** @var string[] */
    public array $mo = [];
    /** Concatenation reference used for every segment of the message being sent. */
    public ?int $fixedReference = null;

    protected function getCsmsReference(): int
    {
        return $this->fixedReference ?? parent::getCsmsReference();
    }

    protected function submitShortMessage(
        Address $source,
        Address $destination,
        string $shortMessage = null,
        array $tags = null,
        int $dataCoding = Smpp::DATA_CODING_DEFAULT,
        int $priority = 0x00,
        string $scheduleDeliveryTime = null,
        string $validityPeriod = null,
        string $esmClass = null
    ): string {
        $id = rtrim(parent::submitShortMessage(
            $source, $destination, $shortMessage, $tags, $dataCoding, $priority,
            $scheduleDeliveryTime, $validityPeriod, $esmClass
        ), "\0");
        $this->submitted[] = $id;
        return $id;
    }

    protected function parseSMS(Pdu $pdu): \Smpp\Pdu\DeliveryReceipt|Sms
    {
        try {
            $sms = parent::parseSMS($pdu);
        } catch (\Throwable $e) {
            // Not parsed by php8-smpp: answer it ourselves and read the receipt id from the raw body.
            $this->sendPDU(new Pdu(Command::DELIVER_SM_RESP, CommandStatus::ESME_ROK, $pdu->getSequence(), "\x00"));
            if (preg_match('/id:(\S+) sub:/', $pdu->getBody(), $m)) {
                $this->receipts[] = $m[1];
            }
            throw new \RuntimeException('handled', 0, $e);
        }
        if (($sms->esmClass & Smpp::ESM_DELIVER_SMSC_RECEIPT) !== 0) {
            if (preg_match('/id:(\S+) sub:/', $sms->message, $m)) {
                $this->receipts[] = $m[1];
            }
        } else {
            $this->mo[] = $sms->dataCoding === Smpp::DATA_CODING_UCS2
                ? mb_convert_encoding($sms->message, 'UTF-8', 'UTF-16BE')
                : mb_convert_encoding($sms->message, 'UTF-8', 'ISO-8859-1');
        }
        return $sms;
    }
}

$transport = ClientBuilder::createForSockets(["$host:$port"])
    ->setCredentials($expected['systemId'], $expected['password'])
    ->buildClient()
    ->transport;
$client = new InteropClient($transport, $expected['systemId'], $expected['password']);
$client->config = (new SmppConfig())
    ->setCsmsMethod(Smpp::CSMS_8BIT_UDH)
    ->setSmsRegisteredDeliveryFlag(Smpp::REG_DELIVERY_SMSC_BOTH);
$transport->open();
$client->bindTransceiver();

$from = new Address('PHP', Smpp::TON_ALPHANUMERIC);
$to = new Address('2250700000000', Smpp::TON_INTERNATIONAL, Smpp::NPI_E164);
$client->sendSMS($from, $to, $expected['short']);
$client->fixedReference = 142; // written as 4 (second decimal digit) in every segment
$client->sendSMS($from, $to, $expected['long'], null, Smpp::DATA_CODING_UCS2);
$client->fixedReference = null;

$deadline = microtime(true) + 15;
while (microtime(true) < $deadline
    && (count($client->receipts) < count($client->submitted) || count($client->mo) === 0)) {
    try {
        $client->readSMS();
    } catch (\RuntimeException $e) {
        if ($e->getMessage() !== 'handled') {
            throw $e;
        }
    }
}

$client->close();
echo json_encode(['submitted' => $client->submitted, 'receipts' => $client->receipts, 'mo' => $client->mo],
    JSON_UNESCAPED_UNICODE), "\n";
