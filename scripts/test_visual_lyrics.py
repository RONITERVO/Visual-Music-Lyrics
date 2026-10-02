import unittest
from visual_lyrics_extractor import assemble_sentences, repair_phrase, ordered_words

class ExtractionTests(unittest.TestCase):
    def test_wrapped_rows_make_two_language_sentence(self):
        observed = [{'start': 1, 'end': 4, 'lines': [
            {'text': 'Bajo la luna llena (Under', 'confidence': .99, 'active': True},
            {'text': 'the full moon)', 'confidence': .99, 'active': True}]}]
        sentences = assemble_sentences(observed)
        self.assertEqual(len(sentences), 1)
        self.assertEqual(sentences[0]['primary'], 'Bajo la luna llena')
        self.assertEqual(sentences[0]['translation'], 'Under the full moon')

    def test_audio_repairs_spacing_but_not_misheard_words(self):
        words = [{'word': w, 'start': i, 'end': i+1} for i,w in enumerate(['Looking','forward'])]
        self.assertEqual(repair_phrase('Look ing forward', words)[0], 'Looking forward')
        wrong = [{'word': w} for w in ['Fire','in','my','head']]
        self.assertEqual(repair_phrase('Fire in my hands', wrong)[0], 'Fire in my hands')

    def test_collapsed_alignment_does_not_overlap_next_language(self):
        words = [dict(value='Hola', start=1., end=2.02, estimated=True), dict(value='Hello',start=2.,end=3.,estimated=False)]
        result = ordered_words(words,1,3)
        self.assertLessEqual(result[0]['end'], result[1]['start'])
        self.assertTrue(result[0]['estimated'])
        self.assertTrue(all(w['end'] > w['start'] for w in result))

if __name__ == '__main__':
    unittest.main()
