import type { Dataset, RecordSource, SourceRecord } from '../lib/types';

/**
 * Fictional April 2025 card statement for the World context demo.
 *
 * People, merchants and amounts are invented. The dates of W01–W04 deliberately fall
 * inside a real, publicly documented event: Visa duplicate settlements on payments made
 * through the InvoiceCloud bill-pay platform from Friday April 11 to Sunday April 13, 2025.
 * Trace does not know this in advance; it has to find it on the public web.
 */
function record(
  id: string, date: string, merchant: string, employee: string, source: RecordSource,
  amountCents: number, description: string, extra: Partial<SourceRecord> = {},
): SourceRecord {
  return {
    id, groupId: id.slice(0, 3), date, merchant, employee, source, amountCents,
    currency: 'USD', description, fileName: `${id}.txt`, ...extra,
  };
}

const billPay = { network: 'Visa', processor: 'InvoiceCloud' };
const toast = { network: 'Mastercard', processor: 'Toast' };

export const worldDemoDataset: Dataset = {
  id: 'northstar-studio-april-2025',
  name: 'Northstar Studio · April 2025 card statement',
  isDemo: true,
  records: [
    // Four employees, four different billers, one weekend: each Visa bill payment posted twice.
    record('W01-E01', '2025-04-11', 'Northgate Water District', 'Maya Chen', 'expense', 18420, 'Studio water and sewer bill paid online with the company Visa.', { reference: 'NW-77310' }),
    record('W01-R01', '2025-04-11', 'Northgate Water District', 'Maya Chen', 'receipt', 18420, 'Online payment confirmation: water and sewer, total $184.20.', { reference: 'NW-77310' }),
    record('W01-C01', '2025-04-11', 'Northgate Water District', 'Maya Chen', 'card', 18420, 'Visa posting INVOICECLOUD*NORTHGATE WATER.', { reference: 'VISA-0411-1183', ...billPay }),
    record('W01-C02', '2025-04-12', 'Northgate Water District', 'Maya Chen', 'card', 18420, 'Second Visa posting, same descriptor and amount, new transaction reference.', { reference: 'VISA-0412-2291', ...billPay }),

    record('W02-E01', '2025-04-11', 'Bayline Gas & Electric', 'Sam Rivera', 'expense', 41275, 'Studio electricity bill paid online with the company Visa.', { reference: 'BGE-4410' }),
    record('W02-R01', '2025-04-11', 'Bayline Gas & Electric', 'Sam Rivera', 'receipt', 41275, 'Online payment confirmation: electricity, total $412.75.', { reference: 'BGE-4410' }),
    record('W02-C01', '2025-04-11', 'Bayline Gas & Electric', 'Sam Rivera', 'card', 41275, 'Visa posting INVOICECLOUD*BAYLINE G&E.', { reference: 'VISA-0411-5520', ...billPay }),
    record('W02-C02', '2025-04-12', 'Bayline Gas & Electric', 'Sam Rivera', 'card', 41275, 'Second Visa posting, same descriptor and amount, new transaction reference.', { reference: 'VISA-0412-6034', ...billPay }),

    record('W03-E01', '2025-04-12', 'Larkspur Mutual Insurance', 'Alex Morgan', 'expense', 26800, 'Monthly business insurance premium paid online with the company Visa.', { reference: 'LMI-2025-04' }),
    record('W03-R01', '2025-04-12', 'Larkspur Mutual Insurance', 'Alex Morgan', 'receipt', 26800, 'Online payment confirmation: premium, total $268.00.', { reference: 'LMI-2025-04' }),
    record('W03-C01', '2025-04-12', 'Larkspur Mutual Insurance', 'Alex Morgan', 'card', 26800, 'Visa posting INVOICECLOUD*LARKSPUR MUTUAL.', { reference: 'VISA-0412-7105', ...billPay }),
    record('W03-C02', '2025-04-13', 'Larkspur Mutual Insurance', 'Alex Morgan', 'card', 26800, 'Second Visa posting, same descriptor and amount, new transaction reference.', { reference: 'VISA-0413-0148', ...billPay }),

    record('W04-E01', '2025-04-12', 'Marina Parking Authority', 'Jordan Ellis', 'expense', 9500, 'Monthly studio parking permit paid online with the company Visa.', { reference: 'MPA-88213' }),
    record('W04-R01', '2025-04-12', 'Marina Parking Authority', 'Jordan Ellis', 'receipt', 9500, 'Online payment confirmation: parking permit, total $95.00.', { reference: 'MPA-88213' }),
    record('W04-C01', '2025-04-12', 'Marina Parking Authority', 'Jordan Ellis', 'card', 9500, 'Visa posting INVOICECLOUD*MARINA PARKING.', { reference: 'VISA-0412-8840', ...billPay }),
    record('W04-C02', '2025-04-13', 'Marina Parking Authority', 'Jordan Ellis', 'card', 9500, 'Second Visa posting, same descriptor and amount, new transaction reference.', { reference: 'VISA-0413-0392', ...billPay }),

    // Three employees at three Toast restaurants: the receipt was photographed before the tip was written in.
    record('W05-E01', '2025-04-03', 'Fogline Kitchen', 'Maya Chen', 'expense', 8600, 'Client lunch entered from the receipt photo: $86.00.', { reference: 'FK-3391' }),
    record('W05-R01', '2025-04-03', 'Fogline Kitchen', 'Maya Chen', 'receipt', 8600, 'Itemized receipt photo: food $79.00, tax $7.00, total $86.00. Tip line blank.', { reference: 'FK-3391' }),
    record('W05-C01', '2025-04-04', 'Fogline Kitchen', 'Maya Chen', 'card', 10320, 'Mastercard posting TST*FOGLINE KITCHEN, settled amount.', { reference: 'MC-0404-3391', ...toast }),

    record('W06-E01', '2025-04-09', 'Ardent Noodle Bar', 'Sam Rivera', 'expense', 5450, 'Team dinner entered from the receipt photo: $54.50.', { reference: 'ANB-1207' }),
    record('W06-R01', '2025-04-09', 'Ardent Noodle Bar', 'Sam Rivera', 'receipt', 5450, 'Itemized receipt photo: food $50.00, tax $4.50, total $54.50. Tip line blank.', { reference: 'ANB-1207' }),
    record('W06-C01', '2025-04-10', 'Ardent Noodle Bar', 'Sam Rivera', 'card', 6431, 'Mastercard posting TST*ARDENT NOODLE, settled amount.', { reference: 'MC-0410-1207', ...toast }),

    record('W07-E01', '2025-04-22', 'Cinder & Salt', 'Jordan Ellis', 'expense', 13200, 'Client dinner entered from the receipt photo: $132.00.', { reference: 'CS-5560' }),
    record('W07-R01', '2025-04-22', 'Cinder & Salt', 'Jordan Ellis', 'receipt', 13200, 'Itemized receipt photo: food $121.00, tax $11.00, total $132.00. Tip line blank.', { reference: 'CS-5560' }),
    record('W07-C01', '2025-04-23', 'Cinder & Salt', 'Jordan Ellis', 'card', 15576, 'Mastercard posting TST*CINDER AND SALT, settled amount.', { reference: 'MC-0423-5560', ...toast }),

    // One mismatch with no shared outside factor: it stays with a reviewer.
    record('W08-E01', '2025-04-17', 'Pier 9 Print Shop', 'Alex Morgan', 'expense', 28650, 'Event banners submitted at $286.50.', { reference: 'P9-0417' }),
    record('W08-R01', '2025-04-17', 'Pier 9 Print Shop', 'Alex Morgan', 'receipt', 26850, 'Banners $250.00; tax $18.50; total $268.50.', { reference: 'P9-0417' }),
    record('W08-C01', '2025-04-18', 'Pier 9 Print Shop', 'Alex Morgan', 'card', 26850, 'Visa posting PIER 9 PRINT SHOP.', { reference: 'VISA-0418-4471', network: 'Visa' }),

    // Clean controls.
    record('W09-E01', '2025-04-15', 'Bayview Rail', 'Alex Morgan', 'expense', 6200, 'Return rail ticket for a client visit.', { reference: 'BR-0415' }),
    record('W09-R01', '2025-04-15', 'Bayview Rail', 'Alex Morgan', 'receipt', 6200, 'Return ticket; total $62.00.', { reference: 'BR-0415' }),
    record('W09-C01', '2025-04-16', 'Bayview Rail', 'Alex Morgan', 'card', 6200, 'Visa posting BAYVIEW RAIL.', { reference: 'VISA-0416-2210', network: 'Visa' }),
    record('W10-E01', '2025-04-24', 'Kestrel Studio Rentals', 'Sam Rivera', 'expense', 32500, 'One-day photography studio rental.', { reference: 'KSR-0424' }),
    record('W10-R01', '2025-04-24', 'Kestrel Studio Rentals', 'Sam Rivera', 'receipt', 32500, 'Studio rental; total $325.00.', { reference: 'KSR-0424' }),
    record('W10-C01', '2025-04-25', 'Kestrel Studio Rentals', 'Sam Rivera', 'card', 32500, 'Visa posting KESTREL STUDIO.', { reference: 'VISA-0425-9183', network: 'Visa' }),
  ],
};
