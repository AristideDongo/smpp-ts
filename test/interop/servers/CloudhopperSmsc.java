// Minimal SMSC built on Cloudhopper SMPP (com.fizzed:ch-smpp 5.0.9, Netty 3), for the smpp-ts client
// interop suite.
//
//   java -cp ch-smpp.jar:ch-commons-util.jar:ch-commons-charset.jar:netty.jar:slf4j-api.jar \
//     test/interop/servers/CloudhopperSmsc.java <port>
//
// Same behaviour as JsmppSmsc.java: accepts binds with system_id "smppts" / password "secret" (any bind
// type), answers submit_sm with a unique message id, and sends a delivery receipt (receipted id =
// submitted id) when one is requested.
import java.lang.ref.WeakReference;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

import com.cloudhopper.smpp.SmppConstants;
import com.cloudhopper.smpp.SmppServerConfiguration;
import com.cloudhopper.smpp.SmppServerHandler;
import com.cloudhopper.smpp.SmppServerSession;
import com.cloudhopper.smpp.SmppSessionConfiguration;
import com.cloudhopper.smpp.impl.DefaultSmppServer;
import com.cloudhopper.smpp.impl.DefaultSmppSessionHandler;
import com.cloudhopper.smpp.pdu.BaseBind;
import com.cloudhopper.smpp.pdu.BaseBindResp;
import com.cloudhopper.smpp.pdu.DeliverSm;
import com.cloudhopper.smpp.pdu.PduRequest;
import com.cloudhopper.smpp.pdu.PduResponse;
import com.cloudhopper.smpp.pdu.SubmitSm;
import com.cloudhopper.smpp.pdu.SubmitSmResp;
import com.cloudhopper.smpp.tlv.Tlv;
import com.cloudhopper.smpp.type.Address;
import com.cloudhopper.smpp.type.SmppProcessingException;

public class CloudhopperSmsc {
    private static final String SYSTEM_ID = "smppts";
    private static final String PASSWORD = "secret";
    private static final AtomicLong IDS = new AtomicLong(5000);
    private static final ScheduledExecutorService RECEIPTS = Executors.newScheduledThreadPool(2);

    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(args.length > 0 ? args[0] : "2775");
        SmppServerConfiguration config = new SmppServerConfiguration();
        config.setHost("127.0.0.1");
        config.setPort(port);
        config.setSystemId("cloudhopper");
        config.setMaxConnectionSize(20);
        config.setNonBlockingSocketsEnabled(true);
        config.setDefaultWindowSize(100);
        config.setDefaultRequestExpiryTimeout(30_000);
        config.setDefaultWindowMonitorInterval(15_000);
        config.setJmxEnabled(false);
        ThreadPoolExecutor executor = (ThreadPoolExecutor) Executors.newCachedThreadPool();
        DefaultSmppServer server = new DefaultSmppServer(config, new BindHandler(), executor);
        server.start();
        System.out.println("Cloudhopper SMSC listening on " + port);
        Thread.currentThread().join();
    }

    static class BindHandler implements SmppServerHandler {
        @Override
        public void sessionBindRequested(Long sessionId, SmppSessionConfiguration sessionConfiguration,
                @SuppressWarnings("rawtypes") BaseBind bindRequest) throws SmppProcessingException {
            if (!SYSTEM_ID.equals(bindRequest.getSystemId()) || !PASSWORD.equals(bindRequest.getPassword())) {
                throw new SmppProcessingException(SmppConstants.STATUS_BINDFAIL, null);
            }
        }

        @Override
        public void sessionCreated(Long sessionId, SmppServerSession session, BaseBindResp preparedBindResponse) {
            session.serverReady(new SessionHandler(session));
        }

        @Override
        public void sessionDestroyed(Long sessionId, SmppServerSession session) {
            session.destroy();
        }
    }

    static class SessionHandler extends DefaultSmppSessionHandler {
        private final WeakReference<SmppServerSession> sessionRef;

        SessionHandler(SmppServerSession session) {
            this.sessionRef = new WeakReference<>(session);
        }

        @Override
        @SuppressWarnings("rawtypes")
        public PduResponse firePduRequestReceived(PduRequest request) {
            PduResponse response = request.createResponse();
            if (request instanceof SubmitSm) {
                SubmitSm submit = (SubmitSm) request;
                String messageId = Long.toString(IDS.incrementAndGet());
                ((SubmitSmResp) response).setMessageId(messageId);
                if ((submit.getRegisteredDelivery() & 0x03) != 0) {
                    RECEIPTS.schedule(() -> sendReceipt(submit, messageId), 200, TimeUnit.MILLISECONDS);
                }
            }
            return response;
        }

        private void sendReceipt(SubmitSm submit, String messageId) {
            SmppServerSession session = sessionRef.get();
            if (session == null || !session.isBound()) return;
            try {
                String now = new SimpleDateFormat("yyMMddHHmm").format(new Date());
                String text = "id:" + messageId + " sub:001 dlvrd:001 submit date:" + now + " done date:" + now
                        + " stat:DELIVRD err:000 text:";
                DeliverSm receipt = new DeliverSm();
                receipt.setEsmClass(SmppConstants.ESM_CLASS_MT_SMSC_DELIVERY_RECEIPT);
                Address from = submit.getDestAddress();
                Address to = submit.getSourceAddress();
                receipt.setSourceAddress(new Address(from.getTon(), from.getNpi(), from.getAddress()));
                receipt.setDestAddress(new Address(to.getTon(), to.getNpi(), to.getAddress()));
                receipt.setShortMessage(text.getBytes(StandardCharsets.ISO_8859_1));
                receipt.addOptionalParameter(new Tlv(SmppConstants.TAG_RECEIPTED_MSG_ID,
                        (messageId + "\0").getBytes(StandardCharsets.ISO_8859_1)));
                session.sendRequestPdu(receipt, 10_000, false);
            } catch (Exception e) {
                System.err.println("receipt failed: " + e);
            }
        }
    }
}
